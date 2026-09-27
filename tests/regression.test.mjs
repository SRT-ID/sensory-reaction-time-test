import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const audioSource = await readFile(new URL('../audio.js', import.meta.url), 'utf8');
const indexSource = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const serviceWorkerSource = await readFile(new URL('../sw.js', import.meta.url), 'utf8');

class FakeAudioContext {
    constructor() {
        this.state = 'suspended';
        this.currentTime = 4;
        this.destination = {};
        this.resumeCalls = 0;
        this.sources = [];
    }

    async resume() {
        this.resumeCalls += 1;
        this.state = 'running';
    }

    async decodeAudioData() {
        return { duration: 1.25 };
    }

    createBufferSource() {
        const source = {
            loop: null,
            startCalls: [],
            stopCalls: [],
            connect() {},
            start(value) { this.startCalls.push(value); },
            stop(value) { this.stopCalls.push(value); }
        };
        this.sources.push(source);
        return source;
    }
}

const audioWindow = {
    AudioContext: FakeAudioContext,
    location: { protocol: 'https:' },
    appOfflineAudio: { getBlobByValue: async () => null }
};
const audioContext = vm.createContext({
    window: audioWindow,
    document: { baseURI: 'https://example.test/' },
    performance: { now: () => 1000 },
    fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }),
    AbortController,
    Audio: class {},
    URL,
    setTimeout,
    clearTimeout,
    console
});
vm.runInContext(audioSource, audioContext);
const player = audioWindow.appAudio;

await player.init();
assert.equal(player.ctx.state, 'running', 'AudioContext must be resumed before auditory tests');
assert.equal(player.ctx.resumeCalls, 1, 'AudioContext should be resumed once');

const playback = await player.playSoundByName('dog', 4);
const source = player.ctx.sources.at(-1);
assert.equal(source.loop, false, 'Auditory stimulus must never loop');
assert.equal(source.startCalls.length, 1, 'Auditory stimulus must start once per trial');
assert.equal(source.stopCalls.length, 1, 'A single natural stop must be scheduled');
assert.equal(source.stopCalls[0], source.startCalls[0] + 1.25, 'Playback stops at file end, not response-window end');
playback.stop();

assert.match(appSource, /pauseForAudioRetry\(error\)/, 'Audio failure should pause for retry');
assert.match(appSource, /label:\s*'إعادة المحاولة'/, 'Audio failure should expose a retry action');
assert.doesNotMatch(appSource, /Audio stimulus failed:[\s\S]{0,250}this\.stop\(\)/, 'Audio failure must not stop the battery');
assert.match(appSource, /if \(this\.hasEnded\) return;/, 'Session completion must be idempotent');
assert.match(appSource, /saveData\(\{ scheduleCloudSync: false \}\);[\s\S]{0,180}saveCompletedTestToCloud/, 'Completed result should have one immediate cloud write path');
assert.match(appSource, /db\.collection\('sessions'\)\.doc\(session\.id\)/, 'Cloud result upsert must use the durable session ID');
assert.match(appSource, /state\.students\.find\(student =>[\s\S]{0,420}canonicalResponseCategory\(category\)/, 'Existing students should be reused by stable identity fields');
assert.match(appSource, /OFFLINE_AUDIO_REFERENCE_PREFIX = 'idb-audio:'/);
assert.match(appSource, /indexedDB\.open\(OFFLINE_AUDIO_DB_NAME, 1\)/);
assert.match(appSource, /status: 'pending'/);
assert.match(appSource, /status: 'synced'/);
assert.match(appSource, /window\.addEventListener\('online'/);
assert.match(appSource, /savedRecord\?\.status !== 'synced'/, 'Upload success must wait for the synced state');
assert.match(appSource, /متوسط زمن الاستجابة \(مللي ثانية\)/);
assert.match(appSource, /milliseconds\(session\.avgReactionTime \|\| 0\)/);
assert.match(appSource, /milliseconds\(session\.stdDevReactionTime\)/);
assert.doesNotMatch(appSource, /stdDevReactionTime\)\.toFixed\(2\).* ث/);
assert.match(appSource, /filter\(result => result\.result === 'correct' && result\.latency !== null\)/, 'Only correct response latencies enter reaction-time statistics');
assert.match(indexSource, /زمن الاستجابة \(مللي ثانية\)/);
assert.match(serviceWorkerSource, /assets\/audio\/dog\.wav/);
assert.match(serviceWorkerSource, /event\.request\.mode === 'navigate'/);
assert.match(serviceWorkerSource, /cacheableDestinations/, 'Offline cache must exclude Firebase data requests');

console.log('Regression checks passed: audio initialization, single playback, retry, offline persistence, deduplication, and millisecond exports.');
