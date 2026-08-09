import { Secret, TOTP } from "otpauth";
import { request } from 'undici';

import { AbstractExternalSource } from './AbstractExternalSource';
import LavaShark from '../LavaShark';
import UnresolvedTrack from '../queue/UnresolvedTrack';

import type { PlaylistInfo, SearchResult } from '../../@types';


interface IAnonymousTokenResponse {
    clientId: string;
    accessToken: string;
    accessTokenExpirationTimestampMs: number;
}
interface IRenewResponse {
    token_type: string;
    access_token: string;
    expires_in: number;
}

interface ISpotifyTrack {
    name: string;
    artists: Array<{
        id: string;
        name: string;
    }>;
    external_urls: {
        spotify: string;
    };
    external_ids?: {
        isrc: string;
    }
    duration_ms: number;
}

interface ISpotifyAlbumTracks {
    items: ISpotifyTrack[];
    next: null | string;
}

interface ISpotifyAlbum {
    name: string;
    tracks: ISpotifyAlbumTracks;
}

interface ISpotifyPlaylistTracks {
    items: Array<{
        track: ISpotifyTrack | null;
    }>;
    next: null | string;
}

interface ISpotifyPlaylist {
    name: string;
    tracks: ISpotifyPlaylistTracks;
}

interface ISpotifyError {
    message: string;
}

interface ISpotifySecret {
    version: number;
    secret: number[];
}

type JsonObject = Record<string, unknown>;

interface IPartnerApiResponse {
    data?: JsonObject;
    errors?: Array<{
        message?: string;
    }>;
}

interface IWebPlayerConfig {
    clientVersion: string;
}


export default class Spotify extends AbstractExternalSource {
    public static readonly SPOTIFY_REGEX = /^(?:https?:\/\/(?:open\.)?spotify\.com|spotify)[/:](?:intl-[a-zA-Z]+\/)?(?<type>track|album|playlist|artist)[/:](?<id>[a-zA-Z0-9]+)/;

    private static readonly USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

    /**
     * Secrets URL from https://github.com/xyloflake/spot-secrets-go
     */
    private readonly SECRETS_URL = 'https://raw.githubusercontent.com/xyloflake/spot-secrets-go/refs/heads/main/secrets/secretBytes.json';
    private readonly CACHE_DURATION = 60 * 60 * 1000;   // Cache duration for secrets (1 hour)
    private readonly MAX_SECRETS_REFRESH_RETRIES = 3;   // Maximum retries for refreshing secrets

    private cachedSecrets: ISpotifySecret[] | null = null;
    private secretsCacheTime: number = 0;

    private readonly auth: string | null;
    private readonly market: string;

    private token: string | null;
    private renewDate: number;

    private partnerAppVersion: string | null;
    private partnerQueryHashes: Map<string, string>;

    constructor(lavashark: LavaShark, clientId?: string, clientSecret?: string, market = 'US') {
        super(lavashark);

        if (clientId && clientSecret) {
            this.auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
        }
        else {
            this.auth = null;
        }

        this.market = market;

        this.token = null;
        this.renewDate = 0;
        this.partnerAppVersion = null;
        this.partnerQueryHashes = new Map();
    }

    public async loadItem(query: string): Promise<SearchResult | null> {
        const spotifyMatch = query.match(Spotify.SPOTIFY_REGEX);

        if (!spotifyMatch || !spotifyMatch.groups) {
            return null;
        }

        switch (spotifyMatch.groups['type']) {
            case 'track': {
                return this.getTrack(spotifyMatch.groups['id']);
            }
            case 'album': {
                return this.getAlbum(spotifyMatch.groups['id']);
            }
            case 'playlist': {
                return this.getPlaylist(spotifyMatch.groups['id']);
            }
            case 'artist': {
                return this.getArtistTopTracks(spotifyMatch.groups['id']);
            }
        }

        return null;
    }

    public async getTrack(id: string): Promise<SearchResult> {
        if (!this.auth) {
            return this.getPartnerTrack(id);
        }

        const res = await this.makeRequest<ISpotifyTrack>(`tracks/${id}`);

        if (res instanceof SpotifyError) {
            return this.handleErrorResult(res);
        }

        return {
            loadType: 'track',
            playlistInfo: {} as PlaylistInfo,
            tracks: [this.buildTrack(res)],
        };
    }

    public async getAlbum(id: string): Promise<SearchResult> {
        if (!this.auth) {
            return this.getPartnerAlbum(id);
        }

        const unresolvedTracks: UnresolvedTrack[] = [];

        let res: ISpotifyAlbum | ISpotifyAlbumTracks | SpotifyError = await this.makeRequest<ISpotifyAlbum>(`albums/${id}`);

        if (res instanceof SpotifyError) {
            return this.handleErrorResult(res);
        }

        const title = res.name;

        for (const it of res.tracks.items) {
            if (it === null) continue;

            unresolvedTracks.push(this.buildTrack(it));
        }

        let next = res.tracks.next !== null;

        while (next && unresolvedTracks.length < 400) {
            res = await this.makeRequest<ISpotifyAlbumTracks>(`albums/${id}/tracks?offset=${unresolvedTracks.length}&limit=50`);

            if (res instanceof SpotifyError) {
                return this.handleErrorResult(res);
            }

            next = res.next !== null;

            for (const it of res.items) {
                unresolvedTracks.push(this.buildTrack(it));
            }
        }

        return {
            loadType: 'playlist',
            playlistInfo: {
                name: title,
                duration: unresolvedTracks.reduce((acc, curr) => acc + curr.duration.value, 0),
                selectedTrack: 0
            },
            tracks: unresolvedTracks,
        };
    }

    public async getPlaylist(id: string): Promise<SearchResult> {
        if (!this.auth) {
            return this.getPartnerPlaylist(id);
        }

        const unresolvedTracks: UnresolvedTrack[] = [];

        let res: ISpotifyPlaylist | ISpotifyPlaylistTracks | SpotifyError = await this.makeRequest<ISpotifyPlaylist>(`playlists/${id}`);

        if (res instanceof SpotifyError) {
            return this.handleErrorResult(res);
        }

        const title = res.name;

        for (const it of res.tracks.items) {
            if (it.track === null) continue;

            unresolvedTracks.push(this.buildTrack(it.track));
        }

        let next = res.tracks.next !== null;

        while (next && unresolvedTracks.length < 400) {
            res = await this.makeRequest<ISpotifyPlaylistTracks>(`playlists/${id}/tracks?offset=${unresolvedTracks.length}`);

            if (res instanceof SpotifyError) {
                return this.handleErrorResult(res);
            }

            next = res.next !== null;

            for (const it of res.items) {
                if (it.track === null) continue;

                unresolvedTracks.push(this.buildTrack(it.track));
            }
        }

        return {
            loadType: 'playlist',
            playlistInfo: {
                name: title,
                duration: unresolvedTracks.reduce((acc, curr) => acc + curr.duration.value, 0),
                selectedTrack: 0
            },
            tracks: unresolvedTracks,
        };
    }

    public async getArtistTopTracks(id: string): Promise<SearchResult> {
        if (!this.auth) {
            return this.getPartnerArtistTopTracks(id);
        }

        const res = await this.makeRequest<{ tracks: ISpotifyTrack[] }>(`artists/${id}/top-tracks?market=${this.market}`);

        if (res instanceof SpotifyError) {
            return this.handleErrorResult(res);
        }

        const tracks = res.tracks.map(t => this.buildTrack(t));

        return {
            loadType: 'playlist',
            playlistInfo: {
                name: `${res.tracks[0].artists.find(a => a.id === id)?.name ?? ''} Top Tracks`,
                duration: tracks.reduce((acc, curr) => acc + curr.duration.value, 0),
                selectedTrack: 0
            },
            tracks: tracks
        };
    }

    private async getPartnerTrack(id: string): Promise<SearchResult> {
        const res = await this.makePartnerRequest('getTrack', {
            uri: `spotify:track:${id}`
        });

        if (res instanceof SpotifyError) {
            return this.handleErrorResult(res);
        }

        const track = Spotify.getObject(res, 'trackUnion');
        const unresolvedTrack = this.buildPartnerTrack(track);

        if (!unresolvedTrack) {
            return this.handleErrorResult(new SpotifyError('Invalid track data received'));
        }

        return {
            loadType: 'track',
            playlistInfo: {} as PlaylistInfo,
            tracks: [unresolvedTrack]
        };
    }

    private async getPartnerPlaylist(id: string): Promise<SearchResult> {
        const unresolvedTracks: UnresolvedTrack[] = [];
        let title = '';
        let offset = 0;
        let totalCount: number;

        do {
            const limit = Math.min(100, 400 - offset);
            const res = await this.makePartnerRequest('fetchPlaylist', {
                uri: `spotify:playlist:${id}`,
                offset,
                limit,
                enableWatchFeedEntrypoint: false
            });

            if (res instanceof SpotifyError) {
                return this.handleErrorResult(res);
            }

            const playlist = Spotify.getObject(res, 'playlistV2');
            const content = Spotify.getObject(playlist, 'content');
            const items = Spotify.getArray(content, 'items');

            title ||= Spotify.getString(playlist, 'name') ?? '';
            totalCount = Spotify.getNumber(content, 'totalCount') ?? items.length;

            for (const item of items) {
                const track = Spotify.getObject(
                    Spotify.getObject(Spotify.getObject(item, 'itemV2'), 'data')
                );
                const type = Spotify.getString(track, '__typename');

                if (type && type.toLowerCase() !== 'track') continue;

                const unresolvedTrack = this.buildPartnerTrack(track);
                if (unresolvedTrack) unresolvedTracks.push(unresolvedTrack);
            }

            if (items.length === 0) break;
            offset += items.length;
        } while (offset < totalCount && offset < 400);

        return this.buildPartnerPlaylistResult(title, unresolvedTracks);
    }

    private async getPartnerAlbum(id: string): Promise<SearchResult> {
        const unresolvedTracks: UnresolvedTrack[] = [];
        let title = '';
        let offset = 0;
        let totalCount: number;

        do {
            const limit = Math.min(50, 400 - offset);
            const res = await this.makePartnerRequest('getAlbum', {
                uri: `spotify:album:${id}`,
                offset,
                limit
            });

            if (res instanceof SpotifyError) {
                return this.handleErrorResult(res);
            }

            const album = Spotify.getObject(res, 'albumUnion');
            const tracks = Spotify.getObject(album, 'tracksV2');
            const items = Spotify.getArray(tracks, 'items');

            title ||= Spotify.getString(album, 'name') ?? '';
            totalCount = Spotify.getNumber(tracks, 'totalCount') ?? items.length;

            for (const item of items) {
                const track = Spotify.getObject(item, 'track');
                const unresolvedTrack = this.buildPartnerTrack(track);
                if (unresolvedTrack) unresolvedTracks.push(unresolvedTrack);
            }

            if (items.length === 0) break;
            offset += items.length;
        } while (offset < totalCount && offset < 400);

        return this.buildPartnerPlaylistResult(title, unresolvedTracks);
    }

    private async getPartnerArtistTopTracks(id: string): Promise<SearchResult> {
        const res = await this.makePartnerRequest('queryArtistOverview', {
            uri: `spotify:artist:${id}`,
            locale: 'en',
            includePrerelease: true
        });

        if (res instanceof SpotifyError) {
            return this.handleErrorResult(res);
        }

        const artist = Spotify.getObject(res, 'artistUnion');
        const artistName = Spotify.getString(
            Spotify.getObject(artist, 'profile'), 'name'
        ) ?? '';
        const discography = Spotify.getObject(artist, 'discography');
        const topTracks = Spotify.getObject(discography, 'topTracks');
        const items = Spotify.getArray(topTracks, 'items');
        const tracks: UnresolvedTrack[] = [];

        for (const item of items) {
            const track = Spotify.firstObject(
                Spotify.getObject(item, 'track'),
                Spotify.getObject(Spotify.getObject(item, 'item'), 'data'),
                Spotify.getObject(Spotify.getObject(item, 'itemV2'), 'data'),
                Spotify.getObject(item, 'data')
            );
            const unresolvedTrack = this.buildPartnerTrack(track);
            if (unresolvedTrack) tracks.push(unresolvedTrack);
        }

        return this.buildPartnerPlaylistResult(
            artistName ? `${artistName} Top Tracks` : 'Top Tracks', tracks
        );
    }

    private buildPartnerPlaylistResult(
        title: string,
        tracks: UnresolvedTrack[]
    ): SearchResult {
        return {
            loadType: 'playlist',
            playlistInfo: {
                name: title,
                duration: tracks.reduce((acc, curr) => acc + curr.duration.value, 0),
                selectedTrack: 0
            },
            tracks
        };
    }

    private buildPartnerTrack(track: JsonObject): UnresolvedTrack | null {
        const title = Spotify.getString(track, 'name') ??
            Spotify.getString(Spotify.getObject(track, 'identityTrait'), 'name');
        const uri = Spotify.getString(track, 'uri');
        const id = uri?.replace('spotify:track:', '') ??
            Spotify.getString(track, 'id');
        const duration = Spotify.getNumber(
            Spotify.getObject(track, 'duration'), 'totalMilliseconds'
        ) ?? Spotify.getNumber(
            Spotify.getObject(track, 'trackDuration'), 'totalMilliseconds'
        ) ?? Spotify.getNumber(track, 'duration_ms');

        if (!title || !id || duration === undefined) {
            return null;
        }

        let artists = Spotify.getArray(Spotify.getObject(track, 'artists'), 'items');
        if (artists.length === 0) {
            artists = [
                ...Spotify.getArray(Spotify.getObject(track, 'firstArtist'), 'items'),
                ...Spotify.getArray(Spotify.getObject(track, 'otherArtists'), 'items')
            ];
        }
        if (artists.length === 0) {
            artists = Spotify.getArray(
                Spotify.getObject(
                    Spotify.getObject(track, 'identityTrait'), 'contributors'
                ),
                'items'
            );
        }

        const artistNames = artists
            .map(artist => Spotify.getString(
                Spotify.getObject(artist, 'profile'), 'name'
            ) ?? Spotify.getString(artist, 'name'))
            .filter((name): name is string => Boolean(name))
            .join(', ');
        const externalIds = Spotify.firstObject(
            Spotify.getObject(track, 'externalIds'),
            Spotify.getObject(track, 'external_ids')
        );

        return new UnresolvedTrack(
            this.lavashark,
            title,
            artistNames || 'Unknown Artist',
            duration,
            `https://open.spotify.com/track/${id}`,
            'spotify',
            Spotify.getString(externalIds, 'isrc')
        );
    }

    private async makePartnerRequest(
        operationName: string,
        variables: JsonObject
    ): Promise<JsonObject | SpotifyError> {
        try {
            if (!this.token || this.renewDate === 0 || Date.now() > this.renewDate) {
                await this.renewToken();
            }

            const hash = await this.getPartnerQueryHash(operationName);
            const response = await request(
                'https://api-partner.spotify.com/pathfinder/v1/query',
                {
                    method: 'POST',
                    headers: {
                        Authorization: this.token as string,
                        'Content-Type': 'application/json',
                        'Spotify-App-Version': this.partnerAppVersion as string,
                        Referer: 'https://open.spotify.com/',
                        Origin: 'https://open.spotify.com',
                        'User-Agent': Spotify.USER_AGENT
                    },
                    body: JSON.stringify({
                        variables,
                        operationName,
                        extensions: {
                            persistedQuery: {
                                version: 1,
                                sha256Hash: hash
                            }
                        }
                    })
                }
            );
            const payload = await response.body.json() as IPartnerApiResponse;

            if (payload.errors?.length) {
                const message = payload.errors
                    .map(error => error.message)
                    .filter((message): message is string => Boolean(message))
                    .join('; ');
                return new SpotifyError(message || 'Spotify Partner API request failed');
            }

            if (response.statusCode >= 400 || !payload.data) {
                return new SpotifyError(
                    `Spotify Partner API returned HTTP ${response.statusCode}`
                );
            }

            return payload.data;
        } catch (error) {
            return new SpotifyError(
                error instanceof Error ? error.message : String(error)
            );
        }
    }

    private async getPartnerQueryHash(operationName: string): Promise<string> {
        const cachedHash = this.partnerQueryHashes.get(operationName);
        if (cachedHash && this.partnerAppVersion) return cachedHash;

        const homepageResponse = await request('https://open.spotify.com/', {
            headers: {
                'User-Agent': Spotify.USER_AGENT,
                Accept: 'text/html'
            }
        });
        const homepage = await homepageResponse.body.text();

        if (homepageResponse.statusCode >= 400) {
            throw new Error(
                `Failed to load Spotify Web Player: HTTP ${homepageResponse.statusCode}`
            );
        }

        const configBase64 = homepage.match(
            /<script id="appServerConfig" type="text\/plain">([^<]+)<\/script>/
        )?.[1];
        const webPlayerUrl = homepage.match(
            /https:\/\/[^"']+\/web-player\/web-player\.[a-f0-9]+\.js/
        )?.[0];

        if (!configBase64 || !webPlayerUrl) {
            throw new Error('Could not locate Spotify Web Player configuration');
        }

        const config = JSON.parse(
            Buffer.from(configBase64, 'base64').toString('utf8')
        ) as IWebPlayerConfig;
        const bundleResponse = await request(webPlayerUrl, {
            headers: {'User-Agent': Spotify.USER_AGENT}
        });
        const bundle = await bundleResponse.body.text();

        if (bundleResponse.statusCode >= 400) {
            throw new Error(
                `Failed to load Spotify Web Player bundle: HTTP ${bundleResponse.statusCode}`
            );
        }

        for (const operation of [
            'getTrack',
            'fetchPlaylist',
            'getAlbum',
            'queryArtistOverview'
        ]) {
            const match = bundle.match(new RegExp(
                `["']${operation}["'],["'](?:query|mutation)["'],["']([a-f0-9]{64})["']`
            ));
            if (match?.[1]) this.partnerQueryHashes.set(operation, match[1]);
        }

        this.partnerAppVersion = config.clientVersion;

        const hash = this.partnerQueryHashes.get(operationName);
        if (!hash) {
            throw new Error(`Could not find Spotify query hash for ${operationName}`);
        }

        this.lavashark.emit(
            'debug',
            `[Spotify] Loaded Partner API metadata for Web Player ${config.clientVersion}`
        );
        return hash;
    }

    private static getObject(value: unknown, key?: string): JsonObject {
        const candidate = key && Spotify.isObject(value) ? value[key] : value;
        return Spotify.isObject(candidate) ? candidate : {};
    }

    private static getArray(value: unknown, key?: string): JsonObject[] {
        const candidate = key && Spotify.isObject(value) ? value[key] : value;
        return Array.isArray(candidate)
            ? candidate.filter(Spotify.isObject)
            : [];
    }

    private static getString(value: unknown, key: string): string | undefined {
        const candidate = Spotify.isObject(value) ? value[key] : undefined;
        return typeof candidate === 'string' ? candidate : undefined;
    }

    private static getNumber(value: unknown, key: string): number | undefined {
        const candidate = Spotify.isObject(value) ? value[key] : undefined;
        return typeof candidate === 'number' ? candidate : undefined;
    }

    private static firstObject(...values: JsonObject[]): JsonObject {
        return values.find(value => Object.keys(value).length > 0) ?? {};
    }

    private static isObject(value: unknown): value is JsonObject {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    private handleErrorResult(error: SpotifyError): SearchResult {
        return {
            loadType: 'error',
            playlistInfo: {} as PlaylistInfo,
            tracks: [],
            exception: {
                message: error.toString(),
                severity: 'SUSPIOUS'
            }
        };
    }

    private buildTrack({ name, artists, external_urls: { spotify }, external_ids, duration_ms }: ISpotifyTrack): UnresolvedTrack {
        const artistNames = artists.map(({ name }) => name).join(', ');

        return new UnresolvedTrack(
            this.lavashark,
            name,
            artistNames,
            duration_ms,
            spotify,
            'spotify',
            external_ids?.isrc
        );
    }

    private async makeRequest<T>(endpoint: string): Promise<T | SpotifyError> {
        if (!this.token || this.renewDate === 0 || Date.now() > this.renewDate) await this.renewToken();

        const res = await request(`https://api.spotify.com/v1/${endpoint}`, {
            headers: {
                Authorization: this.token as string,
                Referer: "https://open.spotify.com/",
                Origin: "https://open.spotify.com",
            }
        }).then(r => r.body.json()) as any;

        if (res.error) {
            return new SpotifyError(res.error.message);
        }

        return res as T;
    }

    private async renewToken() {
        try {
            if (this.auth) {
                await this.getToken();
            } else {
                await this.getAnonymousToken();
            }
        } catch (error) {
            // Try fallback method
            this.lavashark.emit('debug', `[Spotify] Error getting Spotify anonymous token: ${error}`);
            await this.getTokenFallback();
        }
    }

    private async getTokenFallback() {
        try {
            const response = await fetch("https://open.spotify.com/", {
                headers: {
                    "User-Agent": Spotify.USER_AGENT,
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.5",
                    "Accept-Encoding": "gzip, deflate, br",
                    "DNT": "1",
                    "Connection": "keep-alive",
                    "Upgrade-Insecure-Requests": "1"
                }
            });

            const body = await response.text();

            // Trying multiple patterns to extract the token
            let token = body.match(/"accessToken":"([^"]+)"/)?.[1];

            if (!token) {
                token = body.match(/accessToken["']?\s*:\s*["']([^"']+)["']/)?.[1];
            }
            if (!token) {
                token = body.match(/token["']?\s*:\s*["']([^"']+)["']/)?.[1];
            }


            // Trying multiple patterns to extract the expiration time
            let expiresAfter = Number(body.match(/"accessTokenExpirationTimestampMs":(\d+)/)?.[1]);
            if (!expiresAfter) {
                expiresAfter = Number(body.match(/accessTokenExpirationTimestampMs["']?\s*:\s*(\d+)/)?.[1]);
            }
            if (!expiresAfter) {
                // Default to 1 hour
                expiresAfter = Date.now() + 1000 * 60 * 60;
            }


            if (!token) throw new Error("Could not extract access token from Spotify homepage");

            this.token = `Bearer ${token}`;
            this.renewDate = expiresAfter - 5000;
        } catch (error) {
            throw new Error("Failed to retrieve access token from Spotify.", { cause: error });
        }
    }

    private buildTokenUrl() {
        const baseUrl = new URL("https://open.spotify.com/api/token");

        baseUrl.searchParams.set("reason", "init");
        baseUrl.searchParams.set("productType", "web-player");

        return baseUrl;
    }

    private calculateToken(hex: Array<number>, version: number) {
        const token = hex.map((v, i) => v ^ ((i % version) + 9));
        const bufferToken = Buffer.from(token.join(""), "utf8").toString("hex");

        return Secret.fromHex(bufferToken);
    }

    /**
     * Fetch the latest secrets from remote URL
     */
    private async fetchSecretsFromRemote(): Promise<ISpotifySecret[]> {
        try {
            const response = await fetch(this.SECRETS_URL, {
                headers: {
                    'User-Agent': Spotify.USER_AGENT,
                    'Accept': 'application/json',
                    'Cache-Control': 'no-cache'
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const secrets = await response.json() as unknown;

            if (!Array.isArray(secrets) || secrets.length === 0) {
                throw new Error('Invalid secrets format received');
            }

            // Validate secrets format
            const validatedSecrets: ISpotifySecret[] = [];
            for (const secret of secrets) {
                if (typeof secret === 'object' && secret !== null &&
                    typeof (secret as any).version === 'number' &&
                    Array.isArray((secret as any).secret)) {
                    validatedSecrets.push(secret as ISpotifySecret);
                } else {
                    throw new Error('Invalid secret format');
                }
            }

            return validatedSecrets;
        } catch (error) {
            this.lavashark.emit('debug', `[Spotify] Failed to fetch secrets from remote: ${error}`);
            throw error;
        }
    }

    /**
     * Get secrets (prioritize cache, re-fetch when expired)
     */
    private async getSecrets(forceRefresh: boolean = false): Promise<ISpotifySecret[]> {
        const now = Date.now();

        // Check if cache is valid and not forcing refresh
        if (!forceRefresh && this.cachedSecrets && (now - this.secretsCacheTime) < this.CACHE_DURATION) {
            this.lavashark.emit('debug', '[Spotify] Using cached secrets');
            return this.cachedSecrets;
        }

        try {
            this.lavashark.emit('debug', '[Spotify] Fetching secrets from remote...');

            // Try to fetch from remote
            const secrets = await this.fetchSecretsFromRemote();

            // Update cache
            this.cachedSecrets = secrets;
            this.secretsCacheTime = now;

            this.lavashark.emit('debug', `[Spotify] Successfully fetched ${secrets.length} secrets from remote`);
            return secrets;
        } catch (error) {
            this.lavashark.emit('debug', `[Spotify] Failed to fetch remote secrets: ${error}`);

            // If there's old cache, use old cache
            if (this.cachedSecrets && !forceRefresh) {
                this.lavashark.emit('debug', '[Spotify] Using expired cache as fallback');
                return this.cachedSecrets;
            }

            // No available secrets, throw error
            throw new Error('No secrets available and unable to fetch from remote', { cause: error });
        }
    }

    /**
     * Get first available secret from cache
     * Returns null if no secrets available
     */
    private async getNextSecret(): Promise<ISpotifySecret | null> {
        const secrets = await this.getSecrets();

        if (!secrets || secrets.length === 0) {
            return null;
        }

        const secret = secrets[0];
        this.lavashark.emit('debug', `[Spotify] Selecting first secret, version ${secret.version}`);

        return secret;
    }

    /**
     * Remove the failed secret from cache
     * Uses shift() to remove the first element
     */
    private removeCurrentSecret(): void {
        if (!this.cachedSecrets || this.cachedSecrets.length === 0) {
            this.lavashark.emit('debug', '[Spotify] No secrets to remove from cache');
            return;
        }

        const removedSecret = this.cachedSecrets.shift();
        this.lavashark.emit('debug', `[Spotify] Removed failed secret version ${removedSecret?.version}, ${this.cachedSecrets.length} secrets remaining`);
    }


    /**
     * The function that generates an anonymous token is adapted from the iTsMaaT/discord-player-spotify repository.
     * Source: https://github.com/iTsMaaT/discord-player-spotify
     * Commit: ece41db6390e0f22eb8e6008e8892851425a0142
     *
     * The original code is licensed under the MIT License.
     */
    private async getAccessTokenUrl(): Promise<URL | string> {
        if (this.auth) return "https://accounts.spotify.com/api/token?grant_type=client_credentials";

        const selectedSecret = await this.getNextSecret();

        if (!selectedSecret) {
            throw new Error('No secrets available');
        }

        const token = this.calculateToken(selectedSecret.secret, selectedSecret.version);
        this.lavashark.emit('debug', `[Spotify] Using secret version ${selectedSecret.version}`);

        const url = this.buildTokenUrl();
        const { searchParams } = url;

        const cTime = Date.now();
        const sTime = await fetch("https://open.spotify.com/api/server-time/", {
            headers: {
                Referer: "https://open.spotify.com/",
                Origin: "https://open.spotify.com",
                "User-Agent": Spotify.USER_AGENT,
            },
        })
            .then((v) => v.json())
            .then((v: any) => v.serverTime);

        const totp = new TOTP({
            secret: token,
            period: 30,
            digits: 6,
            algorithm: "SHA1",
        });

        const totpServer = totp.generate({
            timestamp: sTime * 1e3,
        });
        const totpClient = totp.generate({
            timestamp: cTime,
        });

        searchParams.set("sTime", String(sTime));
        searchParams.set("cTime", String(cTime));
        searchParams.set("totp", totpClient);
        searchParams.set("totpServer", totpServer);
        searchParams.set("totpVer", "5");
        searchParams.set("buildVer", String(selectedSecret.version));
        // searchParams.set("buildDate", new Date().toISOString().split('T')[0].replace(/-/g, ''));

        return url;
    }

    private async getAnonymousToken() {
        let secretsRefreshCount = 0;

        while (secretsRefreshCount <= this.MAX_SECRETS_REFRESH_RETRIES) {
            // Get current secrets
            const secrets = await this.getSecrets(secretsRefreshCount > 0);

            if (!secrets || secrets.length === 0) {
                throw new Error('No secrets available');
            }

            // Try all secrets in the current cache
            const secretsToTry = [...secrets]; // Copy to track how many we've tried
            let triedCount = 0;

            while (triedCount < secretsToTry.length) {
                try {
                    const accessTokenUrl = await this.getAccessTokenUrl();

                    const {
                        accessToken,
                        accessTokenExpirationTimestampMs
                    } = await request(accessTokenUrl, {
                        headers: {
                            Referer: "https://open.spotify.com/",
                            Origin: "https://open.spotify.com",
                            'User-Agent': Spotify.USER_AGENT
                        }
                    }).then(r => r.body.json() as Promise<IAnonymousTokenResponse>);

                    if (!accessToken) {
                        throw new Error('Failed to get anonymous token on Spotify.');
                    }

                    this.token = `Bearer ${accessToken}`;
                    this.renewDate = accessTokenExpirationTimestampMs - 5000;

                    this.lavashark.emit('debug', '[Spotify] Successfully obtained anonymous token');

                    return;
                } catch (error) {
                    this.lavashark.emit('debug', `[Spotify] Failed to get token with current secret: ${error}`);

                    // Remove the failed secret and try next one
                    this.removeCurrentSecret();
                    triedCount++;

                    // If we still have secrets to try, continue the loop
                    if (this.cachedSecrets && this.cachedSecrets.length > 0) {
                        this.lavashark.emit('debug', `[Spotify] Trying next secret (${this.cachedSecrets.length} remaining in cache)`);
                        continue;
                    } else {
                        // No more secrets in cache
                        this.lavashark.emit('debug', '[Spotify] All secrets in cache failed');
                        break;
                    }
                }
            }

            // All secrets in current cache failed, try refreshing
            secretsRefreshCount++;

            if (secretsRefreshCount <= this.MAX_SECRETS_REFRESH_RETRIES) {
                this.lavashark.emit('debug', `[Spotify] Refreshing secrets from remote (attempt ${secretsRefreshCount}/${this.MAX_SECRETS_REFRESH_RETRIES})`);

                try {
                    await this.getSecrets(true);    // Force refresh
                    // Wait a bit before retrying
                    await new Promise(resolve => setTimeout(resolve, 1000 * secretsRefreshCount));
                } catch (refreshError) {
                    this.lavashark.emit('debug', `[Spotify] Failed to refresh secrets: ${refreshError}`);
                }
            }
        }

        // All retries exhausted
        throw new Error(`Failed to obtain anonymous token after trying all secrets and ${this.MAX_SECRETS_REFRESH_RETRIES} refresh attempts`);
    }

    private async getToken() {
        const {
            token_type,
            access_token,
            expires_in
        } = await request('https://accounts.spotify.com/api/token?grant_type=client_credentials', {
            method: 'POST',
            headers: {
                Authorization: `Basic ${this.auth}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        }).then(r => r.body.json() as Promise<IRenewResponse>);

        this.token = `${token_type} ${access_token}`;
        this.renewDate = Date.now() + expires_in * 1000 - 5000;
    }
}

class SpotifyError implements ISpotifyError {
    readonly message: string;

    constructor(error: string) {
        this.message = error;
    }

    toString(): string {
        return `SpotifyError: ${this.message}`;
    }
}
