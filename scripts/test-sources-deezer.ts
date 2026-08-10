import {runSourceMetadataTests} from './test-sources-utils';
import type {MetadataTestCase} from './test-sources-utils';

const DEEZER_TEST_CASES: MetadataTestCase[] = [
    {
        url: 'https://www.deezer.com/track/3135556',
        expectedLoadType: 'track',
    },
    {
        url: 'https://www.deezer.com/album/302127',
        expectedLoadType: 'playlist',
    },
    {
        url: 'https://www.deezer.com/playlist/908622995',
        expectedLoadType: 'playlist',
    },
];

runSourceMetadataTests({
    sourceName: 'Deezer',
    expectedSource: 'deezer',
    disabledSources: ['APPLE_MUSIC', 'SPOTIFY'],
    testCases: DEEZER_TEST_CASES,
}).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
