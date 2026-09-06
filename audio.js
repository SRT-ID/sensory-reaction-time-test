/**
 * Realistic preset audio with Web Audio timing and synthesized offline fallbacks.
 */

const COMMONS_AUDIO_BASE = 'https://commons.wikimedia.org/wiki/Special:Redirect/file/';
const REALISTIC_SOUND_FILES = Object.freeze({
    buzzer: 'WWS Policewhistle.ogg',
    bell: 'Old school bell 1.ogg',
    alert: 'WWS Signalbell.ogg',
    explosion: 'Explosion-LS100155.ogg',
    bird: 'Birds chirping in a garden.ogg',
    dog: 'Barking of a dog.ogg',
    cat: 'Audio file of cat meowing.ogg',
    horse: 'Wiehern.ogg',
    cow: 'Single Cow Moo.ogg',
    car_horn: 'Car Horn.wav',
    car_engine: '5 cylinder engine sound.ogg',
    train: 'WWS Signalhorntrainhorn.ogg',
    airplane: 'Sound in air plane 1.ogg',
    motorcycle: 'Motorbike 1.ogg'
});

class AudioSynthesizer {
    constructor() {
        this.ctx = null;
        this.bufferCache = new Map();
    }

    init() {
        if (!this.ctx) {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (this.ctx.state === 'suspended') {
            return this.ctx.resume();
        }
        return Promise.resolve();
    }

    isCustomSource(name) {
        return typeof name === 'string' && (name.startsWith('data:audio/') || /^https?:\/\//i.test(name));
    }

    resolveSoundSource(name) {
        if (this.isCustomSource(name)) return name;
        const filename = REALISTIC_SOUND_FILES[name];
        return filename ? `${COMMONS_AUDIO_BASE}${encodeURIComponent(filename)}` : null;
    }

    performanceTimeForAudioContext(contextTime) {
        const outputTimestamp = this.ctx?.getOutputTimestamp?.();
        if (outputTimestamp && Number.isFinite(outputTimestamp.contextTime) && Number.isFinite(outputTimestamp.performanceTime)) {
            return outputTimestamp.performanceTime + ((contextTime - outputTimestamp.contextTime) * 1000);
        }
        return performance.now() + Math.max(0, (contextTime - this.ctx.currentTime) * 1000);
    }

    async prepareCustomSound(name) {
        if (!this.isCustomSource(name)) return null;
        await this.init();
        if (this.bufferCache.has(name)) return this.bufferCache.get(name);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        const pending = fetch(name, { signal: controller.signal })
            .then(response => {
                if (!response.ok) throw new Error(`Audio fetch failed: ${response.status}`);
                return response.arrayBuffer();
            })
            .then(buffer => this.ctx.decodeAudioData(buffer.slice(0)))
            .finally(() => clearTimeout(timeoutId));
        this.bufferCache.set(name, pending);
        try {
            const decoded = await pending;
            this.bufferCache.set(name, decoded);
            return decoded;
        } catch (error) {
            this.bufferCache.delete(name);
            throw error;
        }
    }

    async preloadSounds(values) {
        const sources = [...new Set((values || []).map(value => this.resolveSoundSource(value)).filter(Boolean))];
        await Promise.allSettled(sources.map(source => this.prepareCustomSound(source)));
    }

    // Sound 1: Buzzer / Siren (صفارة) - Used as correct visual/auditory simple cue
    playBuzzer(duration = 0.5) {
        this.init();
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, this.ctx.currentTime); // A5 note

        gain.gain.setValueAtTime(0.15, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start();
        osc.stop(this.ctx.currentTime + duration);
    }

    // Sound 2: Bell (جرس) - Used as distractor or response cue
    playBell(duration = 0.6) {
        this.init();
        const now = this.ctx.currentTime;
        
        // A bell has a fundamental frequency and several higher harmonics (metal chime sound)
        const freqs = [1200, 1500, 1900, 2400];
        const gains = [0.1, 0.05, 0.03, 0.02];

        freqs.forEach((freq, idx) => {
            const osc = this.ctx.createOscillator();
            const gainNode = this.ctx.createGain();

            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, now);

            gainNode.gain.setValueAtTime(gains[idx], now);
            gainNode.gain.exponentialRampToValueAtTime(0.0001, now + duration * (1 - idx * 0.15));

            osc.connect(gainNode);
            gainNode.connect(this.ctx.destination);

            osc.start();
            osc.stop(now + duration);
        });
    }

    // Sound 3: Explosion/Thud (انفجار) - Used as distractor sound
    playExplosion(duration = 0.6) {
        this.init();
        const now = this.ctx.currentTime;
        
        // Low frequency thud/rumble
        const osc = this.ctx.createOscillator();
        const gainNode = this.ctx.createGain();

        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(100, now);
        osc.frequency.exponentialRampToValueAtTime(10, now + duration);

        // Lowpass filter to make it sound muffled/deep
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(200, now);
        filter.frequency.exponentialRampToValueAtTime(50, now + duration);

        gainNode.gain.setValueAtTime(0.2, now);
        gainNode.gain.exponentialRampToValueAtTime(0.001, now + duration);

        osc.connect(filter);
        filter.connect(gainNode);
        gainNode.connect(this.ctx.destination);

        osc.start();
        osc.stop(now + duration);
    }

    // Sound 4: Alert Beep (تنبيه) - Double quick beep
    playAlert(duration = 0.4) {
        this.init();
        const now = this.ctx.currentTime;
        const beepDuration = 0.12;

        const playBeep = (startTime) => {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();

            osc.type = 'square';
            osc.frequency.setValueAtTime(1500, startTime);

            gain.gain.setValueAtTime(0.08, startTime);
            gain.gain.exponentialRampToValueAtTime(0.001, startTime + beepDuration);

            osc.connect(gain);
            gain.connect(this.ctx.destination);

            osc.start(startTime);
            osc.stop(startTime + beepDuration);
        };

        playBeep(now);
        playBeep(now + 0.18);
    }

    // Sound 5: Bird Chirp (طائر) - Pitch sweep upward rapidly
    playBirdChirp(duration = 0.3) {
        this.init();
        const now = this.ctx.currentTime;

        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(1200, now);
        osc.frequency.exponentialRampToValueAtTime(3000, now + duration);

        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start();
        osc.stop(now + duration);
    }

    // Sound 6: Dog Bark (كلب) - Woof woof double bark
    playDogBark(duration = 0.3) {
        this.init();
        const now = this.ctx.currentTime;
        const playWoof = (startTime) => {
            const osc = this.ctx.createOscillator();
            const gainNode = this.ctx.createGain();
            const filter = this.ctx.createBiquadFilter();

            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(140, startTime);
            osc.frequency.exponentialRampToValueAtTime(60, startTime + 0.15);

            filter.type = 'lowpass';
            filter.frequency.setValueAtTime(300, startTime);

            gainNode.gain.setValueAtTime(0.15, startTime);
            gainNode.gain.exponentialRampToValueAtTime(0.001, startTime + 0.15);

            osc.connect(filter);
            filter.connect(gainNode);
            gainNode.connect(this.ctx.destination);

            osc.start(startTime);
            osc.stop(startTime + 0.15);
        };
        playWoof(now);
        playWoof(now + 0.18);
    }

    // Sound 7: Cat Meow (قطة) - Sweeping triangle wave
    playCatMeow(duration = 0.5) {
        this.init();
        const now = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gainNode = this.ctx.createGain();

        osc.type = 'triangle';
        osc.frequency.setValueAtTime(600, now);
        osc.frequency.exponentialRampToValueAtTime(900, now + 0.15);
        osc.frequency.exponentialRampToValueAtTime(700, now + duration);

        gainNode.gain.setValueAtTime(0.08, now);
        gainNode.gain.linearRampToValueAtTime(0.08, now + duration - 0.1);
        gainNode.gain.exponentialRampToValueAtTime(0.001, now + duration);

        osc.connect(gainNode);
        gainNode.connect(this.ctx.destination);

        osc.start();
        osc.stop(now + duration);
    }

    // Sound 8: Car Horn (هرن سيارة) - Retro dual tone beep beep
    playCarHorn(duration = 0.5) {
        this.init();
        const now = this.ctx.currentTime;
        const playBeep = (startTime) => {
            const osc1 = this.ctx.createOscillator();
            const osc2 = this.ctx.createOscillator();
            const gainNode = this.ctx.createGain();
            
            osc1.type = 'triangle';
            osc1.frequency.setValueAtTime(400, startTime);
            
            osc2.type = 'triangle';
            osc2.frequency.setValueAtTime(440, startTime);
            
            gainNode.gain.setValueAtTime(0.12, startTime);
            gainNode.gain.exponentialRampToValueAtTime(0.001, startTime + 0.15);
            
            osc1.connect(gainNode);
            osc2.connect(gainNode);
            gainNode.connect(this.ctx.destination);
            
            osc1.start(startTime);
            osc1.stop(startTime + 0.15);
            osc2.start(startTime);
            osc2.stop(startTime + 0.15);
        };
        playBeep(now);
        playBeep(now + 0.2);
    }

    // Sound 9: Car Engine (محرك سيارة) - Low frequency sawtooth rumble
    playCarEngine(duration = 0.8) {
        this.init();
        const now = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gainNode = this.ctx.createGain();
        const filter = this.ctx.createBiquadFilter();

        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(60, now);
        osc.frequency.linearRampToValueAtTime(90, now + 0.3);
        osc.frequency.linearRampToValueAtTime(50, now + duration);

        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(120, now);

        gainNode.gain.setValueAtTime(0.15, now);
        gainNode.gain.linearRampToValueAtTime(0.15, now + duration - 0.2);
        gainNode.gain.exponentialRampToValueAtTime(0.001, now + duration);

        osc.connect(filter);
        filter.connect(gainNode);
        gainNode.connect(this.ctx.destination);

        osc.start();
        osc.stop(now + duration);
    }

    // Sound 10: Lion Roar (أسد) - Modulated growl / rumble
    playLionRoar(duration = 1.0) {
        this.init();
        const now = this.ctx.currentTime;
        
        const osc = this.ctx.createOscillator();
        const oscGain = this.ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(80, now);
        osc.frequency.linearRampToValueAtTime(50, now + duration);
        
        // 12Hz rumble shake
        const mod = this.ctx.createOscillator();
        const modGain = this.ctx.createGain();
        mod.frequency.value = 12;
        modGain.gain.value = 15;
        
        mod.connect(modGain);
        modGain.connect(osc.frequency);
        
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(300, now);
        filter.frequency.linearRampToValueAtTime(150, now + duration);
        
        oscGain.gain.setValueAtTime(0.2, now);
        oscGain.gain.exponentialRampToValueAtTime(0.001, now + duration);
        
        osc.connect(filter);
        filter.connect(oscGain);
        oscGain.connect(this.ctx.destination);
        
        osc.start(now);
        mod.start(now);
        osc.stop(now + duration);
        mod.stop(now + duration);
    }

    // Sound 11: Horse Neigh (حصان) - Fast LFO pitch-modulated sweep
    playHorseNeigh(duration = 0.8) {
        this.init();
        const now = this.ctx.currentTime;
        
        const osc = this.ctx.createOscillator();
        const oscGain = this.ctx.createGain();
        const filter = this.ctx.createBiquadFilter();
        
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(900, now);
        osc.frequency.linearRampToValueAtTime(1400, now + 0.2);
        osc.frequency.exponentialRampToValueAtTime(700, now + duration);
        
        // 25Hz vocal flutter
        const lfo = this.ctx.createOscillator();
        const lfoGain = this.ctx.createGain();
        lfo.frequency.value = 25;
        lfoGain.gain.value = 80;
        
        lfo.connect(lfoGain);
        lfoGain.connect(osc.frequency);
        
        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(1200, now);
        filter.Q.value = 1.0;
        
        oscGain.gain.setValueAtTime(0.08, now);
        oscGain.gain.exponentialRampToValueAtTime(0.001, now + duration);
        
        osc.connect(filter);
        filter.connect(oscGain);
        oscGain.connect(this.ctx.destination);
        
        osc.start(now);
        lfo.start(now);
        osc.stop(now + duration);
        lfo.stop(now + duration);
    }

    // General Play function matching the image structure
    async playSoundByName(name) {
        if (!name) return;
        await this.init();

        const realisticSource = this.resolveSoundSource(name);
        if (realisticSource) {
            try {
                const buffer = await this.prepareCustomSound(realisticSource);
                const source = this.ctx.createBufferSource();
                source.buffer = buffer;
                source.connect(this.ctx.destination);
                const scheduledAt = this.ctx.currentTime + 0.04;
                const onsetPerformanceTime = this.performanceTimeForAudioContext(scheduledAt);
                source.start(scheduledAt);
                source.stop(scheduledAt + Math.min(buffer.duration, 2.2));
                return { onsetPerformanceTime, scheduledAt };
            } catch (error) {
                console.warn('Realistic audio unavailable; using the offline fallback.', error);
            }
        }

        const onsetPerformanceTime = performance.now();
        switch (name) {
            case 'buzzer':
            case 'صفارة':
                this.playBuzzer();
                break;
            case 'bell':
            case 'جرس':
                this.playBell();
                break;
            case 'explosion':
            case 'انفجار':
                this.playExplosion();
                break;
            case 'alert':
            case 'تنبيه':
                this.playAlert();
                break;
            case 'bird':
            case 'طائر':
                this.playBirdChirp();
                break;
            case 'dog':
            case 'كلب':
                this.playDogBark();
                break;
            case 'cat':
            case 'قطة':
                this.playCatMeow();
                break;
            case 'car_horn':
            case 'هرن سيارة':
            case 'هرن':
                this.playCarHorn();
                break;
            case 'car_engine':
            case 'محرك سيارة':
            case 'محرك':
                this.playCarEngine();
                break;
            case 'lion':
            case 'أسد':
                this.playLionRoar();
                break;
            case 'horse':
            case 'حصان':
                this.playHorseNeigh();
                break;
            case 'cow':
            case 'بقرة':
                this.playLionRoar(1.2);
                break;
            case 'train':
            case 'قطار':
                this.playCarHorn(1.2);
                break;
            case 'airplane':
            case 'طائرة':
                this.playCarEngine(1.5);
                break;
            case 'motorcycle':
            case 'دراجة نارية':
                this.playCarEngine(1.5);
                break;
            default:
                this.playBuzzer();
        }
        return { onsetPerformanceTime, scheduledAt: this.ctx.currentTime };
    }
}

const appAudio = new AudioSynthesizer();
window.appAudio = appAudio;
