import {runSourceMetadataTests} from './test-sources-utils';
import type {MetadataTestCase} from './test-sources-utils';

const SPOTIFY_TEST_CASES: MetadataTestCase[] = [
    {
        url: 'https://open.spotify.com/playlist/7KhGv5R88sPkQylsPt3SYd?si=QS5iAK49TcCNdPO8kqTLxQ',
        expectedLoadType: 'playlist',
    },
    {
        url: 'https://open.spotify.com/track/6MNY72T605kPIOH3hnioxu?si=5eee7c537bd7402c',
        expectedLoadType: 'track',
    },
    {
        url: 'https://open.spotify.com/album/7qemUq4n71awwVPOaX7jw4',
        expectedLoadType: 'playlist',
    },
    {
        url: 'https://open.spotify.com/artist/3ZztVuWxHzNpl0THurTFCv',
        expectedLoadType: 'playlist',
    },
];

runSourceMetadataTests({
    sourceName: 'Spotify',
    expectedSource: 'spotify',
    disabledSources: ['APPLE_MUSIC', 'DEEZER'],
    testCases: SPOTIFY_TEST_CASES,
}).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
