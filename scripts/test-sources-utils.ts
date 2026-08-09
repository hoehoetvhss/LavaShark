import assert from 'node:assert/strict';

import {LavaShark} from '../src';
import type {LavaSharkOptions, SearchResult} from '../src/@types';

export type MetadataTestCase = {
    url: string;
    expectedLoadType: 'playlist' | 'track';
};

type MetadataTestOptions = {
    sourceName: string;
    expectedSource: string;
    disabledSources: NonNullable<LavaSharkOptions['disabledSources']>;
    testCases: MetadataTestCase[];
};

const METADATA_TEST_NODE = {
    id: 'metadata-test',
    hostname: '127.0.0.1',
    port: 1,
    password: 'metadata-test',
};

function summarizeResult(url: string, result: SearchResult): void {
    console.log(JSON.stringify({
        url,
        loadType: result.loadType,
        playlistName: result.playlistInfo?.name,
        trackCount: result.tracks.length,
        firstTrack: result.tracks[0]?.title,
        firstAuthor: result.tracks[0]?.author,
        firstDuration: result.tracks[0]?.duration.value,
        exception: result.exception?.message,
    }, null, 2));
}

export async function runSourceMetadataTests(
    options: MetadataTestOptions
): Promise<void> {
    const lavashark = new LavaShark({
        nodes: [METADATA_TEST_NODE],
        sendWS: () => {},
        disabledSources: options.disabledSources,
    });

    lavashark.on('debug', message => console.error(message));

    for (const testCase of options.testCases) {
        const result = await lavashark.search(testCase.url);
        summarizeResult(testCase.url, result);

        assert.equal(result.loadType, testCase.expectedLoadType,
            `${options.sourceName} returned ${result.loadType} for ` +
            `${testCase.url}: ${result.exception?.message}`);
        assert.ok(result.tracks.length > 0,
            `${options.sourceName} returned an empty track list for ` +
            `${testCase.url}.`);

        const firstTrack = result.tracks[0];
        assert.ok(firstTrack.title && firstTrack.author,
            `${options.sourceName} returned incomplete metadata for ` +
            `${testCase.url}.`);
        assert.ok(firstTrack.duration.value > 0,
            `${options.sourceName} returned an invalid duration for ` +
            `${testCase.url}.`);
        assert.ok(firstTrack.uri,
            `${options.sourceName} returned an empty URI for ${testCase.url}.`);
        assert.equal(firstTrack.source, options.expectedSource,
            `${options.sourceName} returned an unexpected source for ` +
            `${testCase.url}.`);
    }
}
