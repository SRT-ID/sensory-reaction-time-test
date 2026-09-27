/**
 * تشغيل ملفات الأصوات الحقيقية المرفقة بالمشروع مع توقيت Web Audio الدقيق.
 */

const REAL_SOUND_FILES = Object.freeze({
    dog: 'assets/audio/dog.wav',
    cat: 'assets/audio/cat.wav',
    bird: 'assets/audio/bird.wav',
    cow: 'assets/audio/cow.wav',
    donkey: 'assets/audio/donkey.wav',
    goat: 'assets/audio/goat.wav'
});

class RealAudioPlayer {
    constructor() {
        this.ctx = null;
        this.bufferCache = new Map();
    }

    async init() {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) {
            const error = new Error('هذا المتصفح لا يدعم Web Audio.');
            error.code = 'audio/context-unsupported';
            throw error;
        }
        if (!this.ctx || this.ctx.state === 'closed') {
            this.ctx = new AudioContextClass();
        }
        if (this.ctx.state !== 'running' && typeof this.ctx.resume === 'function') {
            await this.ctx.resume();
        }
        if (this.ctx.state !== 'running') {
            const error = new Error('تعذر تهيئة نظام الصوت في المتصفح.');
            error.code = 'audio/context-not-running';
            throw error;
        }
    }

    isDirectAudioSource(value) {
        return typeof value === 'string' && (
            value.startsWith('data:audio/')
            || /^https?:\/\//i.test(value)
            || /^\.?\/?assets\/audio\//i.test(value)
        );
    }

    resolveSoundSource(value) {
        if (this.isDirectAudioSource(value)) return value;
        return REAL_SOUND_FILES[value] || null;
    }

    resolveSoundUrl(value) {
        const source = this.resolveSoundSource(value);
        if (!source || source.startsWith('data:') || /^https?:\/\//i.test(source)) return source;
        try {
            return new URL(source, document.baseURI).href;
        } catch (error) {
            return source;
        }
    }

    async resolveAudioResource(value) {
        const localBlob = await window.appOfflineAudio?.getBlobByValue?.(value);
        if (localBlob) {
            return {
                source: URL.createObjectURL(localBlob),
                cacheKey: value,
                revoke: true
            };
        }
        return {
            source: this.resolveSoundUrl(value),
            cacheKey: this.resolveSoundUrl(value),
            revoke: false
        };
    }

    performanceTimeForAudioContext(contextTime) {
        const outputTimestamp = this.ctx?.getOutputTimestamp?.();
        if (outputTimestamp && Number.isFinite(outputTimestamp.contextTime) && Number.isFinite(outputTimestamp.performanceTime)) {
            return outputTimestamp.performanceTime + ((contextTime - outputTimestamp.contextTime) * 1000);
        }
        return performance.now() + Math.max(0, (contextTime - this.ctx.currentTime) * 1000);
    }

    async prepareSound(value) {
        const resource = await this.resolveAudioResource(value);
        const { source, cacheKey, revoke } = resource;
        if (!source) {
            const error = new Error('مصدر الصوت غير موجود في قائمة الأصوات الحقيقية.');
            error.code = 'audio/source-not-found';
            throw error;
        }

        await this.init();
        if (this.bufferCache.has(cacheKey)) {
            if (revoke) URL.revokeObjectURL(source);
            return this.bufferCache.get(cacheKey);
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        const pending = fetch(source, { signal: controller.signal })
            .then(response => {
                if (!response.ok) throw new Error(`Audio fetch failed: ${response.status}`);
                return response.arrayBuffer();
            })
            .then(buffer => this.ctx.decodeAudioData(buffer.slice(0)))
            .finally(() => {
                clearTimeout(timeoutId);
                if (revoke) URL.revokeObjectURL(source);
            });

        this.bufferCache.set(cacheKey, pending);
        try {
            const decoded = await pending;
            this.bufferCache.set(cacheKey, decoded);
            return decoded;
        } catch (error) {
            this.bufferCache.delete(cacheKey);
            throw error;
        }
    }

    async preloadSounds(values) {
        const uniqueValues = [...new Set((values || []).filter(Boolean))];
        if (window.location?.protocol === 'file:') return;
        const results = await Promise.allSettled(uniqueValues.map(value => this.prepareSound(value)));
        const failedValues = results
            .map((result, index) => result.status === 'rejected' ? uniqueValues[index] : null)
            .filter(Boolean);
        if (failedValues.length) {
            const error = new Error(`تعذر تجهيز ${failedValues.length} ملف صوتي.`);
            error.code = 'audio/preload-failed';
            error.failedValues = failedValues;
            throw error;
        }
    }

    async playWithHtmlAudio(value, maxDurationSeconds = null) {
        const resource = await this.resolveAudioResource(value);
        const { source, revoke } = resource;
        if (!source) {
            const error = new Error('مصدر الصوت غير موجود في قائمة الأصوات الحقيقية.');
            error.code = 'audio/source-not-found';
            throw error;
        }

        const audio = new Audio();
        audio.src = source;
        audio.preload = 'auto';
        audio.loop = false;

        let stopped = false;
        let stopTimer = null;
        let loadTimer = null;
        const stop = () => {
            if (stopped) return;
            stopped = true;
            clearTimeout(stopTimer);
            clearTimeout(loadTimer);
            audio.pause();
            audio.removeAttribute('src');
            audio.load();
            if (revoke) URL.revokeObjectURL(source);
        };

        const onsetPromise = new Promise((resolve, reject) => {
            loadTimer = setTimeout(() => {
                const error = new Error('انتهت مهلة تحميل ملف الصوت.');
                error.code = 'audio/load-timeout';
                reject(error);
            }, 15000);
            audio.addEventListener('playing', () => {
                clearTimeout(loadTimer);
                resolve(performance.now());
            }, { once: true });
            audio.addEventListener('error', () => {
                clearTimeout(loadTimer);
                const error = new Error('تعذر على المتصفح تشغيل ملف WAV.');
                error.code = 'audio/html-playback-failed';
                reject(error);
            }, { once: true });
        });

        try {
            const [, onsetPerformanceTime] = await Promise.all([audio.play(), onsetPromise]);
            const requestedDuration = Number(maxDurationSeconds);
            if (Number.isFinite(requestedDuration) && requestedDuration > 0) {
                stopTimer = setTimeout(stop, requestedDuration * 1000);
            }
            return { onsetPerformanceTime, scheduledAt: null, stop };
        } catch (error) {
            stop();
            throw error;
        }
    }

    async playSoundByName(value, maxDurationSeconds = null) {
        if (window.location?.protocol === 'file:') {
            return this.playWithHtmlAudio(value, maxDurationSeconds);
        }
        try {
            const buffer = await this.prepareSound(value);
            const source = this.ctx.createBufferSource();
            source.buffer = buffer;
            source.connect(this.ctx.destination);

            const scheduledAt = this.ctx.currentTime + 0.04;
            const onsetPerformanceTime = this.performanceTimeForAudioContext(scheduledAt);
            const requestedDuration = Number(maxDurationSeconds);
            const playbackDuration = Number.isFinite(requestedDuration) && requestedDuration > 0
                ? requestedDuration
                : buffer.duration;

            source.loop = false;
            source.start(scheduledAt);
            source.stop(scheduledAt + Math.min(playbackDuration, buffer.duration));

            return {
                onsetPerformanceTime,
                scheduledAt,
                stop: () => {
                    try { source.stop(); } catch (error) { /* انتهى تشغيل الصوت بالفعل */ }
                }
            };
        } catch (webAudioError) {
            try {
                return await this.playWithHtmlAudio(value, maxDurationSeconds);
            } catch (htmlAudioError) {
                const playbackError = new Error('تعذر تحميل أو فك ترميز ملف الصوت الحقيقي.');
                playbackError.code = htmlAudioError?.code || webAudioError?.code || 'audio/real-source-unavailable';
                playbackError.cause = { webAudioError, htmlAudioError };
                throw playbackError;
            }
        }
    }

    invalidate(value) {
        const source = this.resolveSoundUrl(value);
        this.bufferCache.delete(value);
        if (source) this.bufferCache.delete(source);
    }
}

const appAudio = new RealAudioPlayer();
window.appAudio = appAudio;
