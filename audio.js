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

    init() {
        if (!this.ctx) {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (this.ctx.state === 'suspended') return this.ctx.resume();
        return Promise.resolve();
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

    performanceTimeForAudioContext(contextTime) {
        const outputTimestamp = this.ctx?.getOutputTimestamp?.();
        if (outputTimestamp && Number.isFinite(outputTimestamp.contextTime) && Number.isFinite(outputTimestamp.performanceTime)) {
            return outputTimestamp.performanceTime + ((contextTime - outputTimestamp.contextTime) * 1000);
        }
        return performance.now() + Math.max(0, (contextTime - this.ctx.currentTime) * 1000);
    }

    async prepareSound(value) {
        const source = this.resolveSoundUrl(value);
        if (!source) {
            const error = new Error('مصدر الصوت غير موجود في قائمة الأصوات الحقيقية.');
            error.code = 'audio/source-not-found';
            throw error;
        }

        await this.init();
        if (this.bufferCache.has(source)) return this.bufferCache.get(source);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        const pending = fetch(source, { signal: controller.signal })
            .then(response => {
                if (!response.ok) throw new Error(`Audio fetch failed: ${response.status}`);
                return response.arrayBuffer();
            })
            .then(buffer => this.ctx.decodeAudioData(buffer.slice(0)))
            .finally(() => clearTimeout(timeoutId));

        this.bufferCache.set(source, pending);
        try {
            const decoded = await pending;
            this.bufferCache.set(source, decoded);
            return decoded;
        } catch (error) {
            this.bufferCache.delete(source);
            throw error;
        }
    }

    async preloadSounds(values) {
        const uniqueValues = [...new Set((values || []).filter(Boolean))];
        if (window.location?.protocol === 'file:') return;
        await Promise.allSettled(uniqueValues.map(value => this.prepareSound(value)));
    }

    async playWithHtmlAudio(value, maxDurationSeconds = null) {
        const source = this.resolveSoundUrl(value);
        if (!source) {
            const error = new Error('مصدر الصوت غير موجود في قائمة الأصوات الحقيقية.');
            error.code = 'audio/source-not-found';
            throw error;
        }

        const audio = new Audio();
        audio.src = source;
        audio.preload = 'auto';
        audio.loop = true;

        let stopped = false;
        let stopTimer = null;
        const stop = () => {
            if (stopped) return;
            stopped = true;
            clearTimeout(stopTimer);
            audio.pause();
            audio.removeAttribute('src');
            audio.load();
        };

        const onsetPromise = new Promise((resolve, reject) => {
            const loadTimer = setTimeout(() => {
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

            source.loop = playbackDuration > buffer.duration;
            source.start(scheduledAt);
            source.stop(scheduledAt + playbackDuration);

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
}

const appAudio = new RealAudioPlayer();
window.appAudio = appAudio;
