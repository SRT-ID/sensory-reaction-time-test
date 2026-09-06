/**
 * Sensory Reaction Time Application Logic
 * Manages state, views, local storage, Chart.js integrations, and the active test engine.
 */

// ==========================================================================
// FIREBASE CONFIGURATION
// ==========================================================================
// Firebase web configuration (the API key is a public client identifier; access is enforced by the security rules).
const firebaseConfig = {
    apiKey: "AIzaSyCgJbfMw7MnwgAxjYrZilw2onLiHsuD5jM",
    authDomain: "srt-id-ba9e8.firebaseapp.com",
    projectId: "srt-id-ba9e8",
    storageBucket: "srt-id-ba9e8.firebasestorage.app",
    messagingSenderId: "998368877791",
    appId: "1:998368877791:web:01fc0dbf77053ecd03dd6a",
    measurementId: "G-5NCLFZMH89"
};

let db = null;
let auth = null;
let storage = null;
let useFirebase = false;
let firebaseUser = null;
let firebaseReadyResolver = null;
let firebaseReady = new Promise(resolve => { firebaseReadyResolver = resolve; });
let syncTimer = null;
let sharedRefreshTimer = null;
let sharedRealtimeUnsubscribers = [];
let pendingDeletions = { students: {}, sessions: {} };
const sharedDeletedIds = { students: new Set(), sessions: new Set() };
let lastCloudStatus = { status: 'connecting', title: 'جاري الاتصال بالسحابة...', detail: '' };

function updateCloudStatusUI(status, title, detail = '') {
    lastCloudStatus = { status, title, detail };
    const badge = document.getElementById('cloudStatusBadge');
    const textEl = document.getElementById('cloudStatusText');
    if (!badge || !textEl) return;
    badge.className = `cloud-status-badge ${status}`;
    textEl.textContent = title;
    badge.title = detail ? `${title}: ${detail} (انقر للتفاصيل)` : title;
}

if (firebaseConfig.apiKey && typeof firebase !== 'undefined' && typeof firebase.auth === 'function') {
    try {
        if (!firebase.apps?.length) firebase.initializeApp(firebaseConfig);
        db = firebase.firestore();
        auth = firebase.auth();
        storage = typeof firebase.storage === 'function' ? firebase.storage() : null;

        // Offline persistence with multi-tab support fallback
        if (typeof db.enableMultiTabIndexedDbPersistence === 'function') {
            db.enableMultiTabIndexedDbPersistence().catch((err) => {
                console.warn("Firestore multi-tab persistence warning:", err.code);
            });
        } else if (typeof db.enablePersistence === 'function') {
            db.enablePersistence({ synchronizeTabs: true }).catch((err) => {
                console.warn("Firestore persistence warning:", err.code);
            });
        }

        // Automatic authentication listener for robust connection management
        auth.onAuthStateChanged((user) => {
            if (user) {
                activateFirebaseUser(user);
                updateCloudStatusUI('connected', '🟢 متصل بالسحابة (مزامنة فورية)', 'يتم حفظ المشاركين والنتائج تلقائياً وإتاحتها لجميع الأجهزة المقترنة.');
                if (firebaseReadyResolver) firebaseReadyResolver(user);
                syncFromFirestore();
            } else {
                updateCloudStatusUI('connecting', '🟡 جاري الاتصال بالسحابة...');
                auth.signInAnonymously().catch(error => {
                    handleFirebaseAuthError(error);
                });
            }
        });
    } catch (e) {
        console.error("Firebase initialization failed:", e);
        updateCloudStatusUI('error', '🔴 خطأ تهيئة السحابة', e.message);
    }
} else {
    updateCloudStatusUI('offline', '🟠 حفظ محلي فقط', 'عنصر التحكم في مكتبة Firebase غير متوفر. يتم الحفظ على جهازك فقط.');
}

function handleFirebaseAuthError(error) {
    console.error("Firebase authentication failed:", error);
    useFirebase = false;
    firebaseUser = null;
    if (firebaseReadyResolver) firebaseReadyResolver(null);

    const errCode = error?.code || '';
    const errMessage = error?.message || '';

    if (errCode === 'auth/operation-not-allowed' || errCode === 'auth/api-key-not-valid' || errMessage.includes('CONFIGURATION_NOT_FOUND')) {
        const detailMsg = 'خدمة مصادقة المستخدمين تحتاج تفعيل زر (Get Started) ثم تفعيل Anonymous في قسم Authentication بـ Firebase Console.';
        updateCloudStatusUI('offline', '🟠 حفظ محلي (انقر للتفعيل السحابي)', detailMsg);
    } else {
        const detailMsg = errMessage || 'تعذر الاتصال بـ Firebase.';
        updateCloudStatusUI('offline', '🟠 حفظ محلي على الجهاز', detailMsg);
    }
}

function activateFirebaseUser(user) {
    if (!user || !db) return null;
    firebaseUser = user;
    useFirebase = true;
    return user;
}

// Global State
const state = {
    students: [],
    sessions: [],
    activeStudentId: null,
    currentRunningTest: null, // Holds the active TestEngine instance
    testQueue: [],            // Queue of test types to run sequentially
    sessionStudent: null,     // Student data entered in tests-view form
    sessionSpecialist: null,  // Specialist data entered in tests-view form
    settings: {
        general: {
            trialsCount: 20,
            practiceEnabled: true,
            practiceTrialsCount: 3,
            practiceOpenEnded: false,
            practiceFeedback: true,
            testFeedback: false,
            minLatency: 0.5,
            maxLatency: 3.0,
            stimulusDuration: 1.0,
            interStimulus: 1.0,
            maxResponseTime: 3.0,
            randomOrder: true
        },
        instructions: {
            'visual-simple': "ستظهر دائرة خضراء في وسط الشاشة.<br>عند ظهور الدائرة اضغط على زر <b>المسافة (Spacebar)</b> بأسرع ما يمكن.<br>لا تفعل شيئاً إذا لم تظهر الدائرة.",
            'visual-discriminative': "ستظهر ألوان مختلفة في وسط الشاشة.<br>اضغط على زر <b>المسافة (Spacebar)</b> فقط عند ظهور الدائرة الخضراء.<br>تجاهل الألوان الأخرى (الحمراء والزرقاء والصفراء) ولا تضغط على أي زر.",
            'visual-choice': "ستظهر مثيرات بصرية مختلفة، ولكل مثير زر استجابة محدد.<br>استخدم دليل الاستجابة الظاهر قبل بدء الاختبار واضغط الزر المطابق للمثير بأسرع ما يمكن.",
            'auditory-simple': "ستسمع صوتاً واحداً (صفارة).<br>عند سماع الصوت اضغط على زر <b>المسافة (Spacebar)</b> بأسرع ما يمكن.<br>لا تفعل شيئاً إذا لم تسمع الصوت.",
            'auditory-discriminative': "ستسمع أصواتاً مختلفة.<br>اضغط على زر <b>المسافة (Spacebar)</b> فقط عند سماع الصوت الصحيح (الصفارة).<br>تجاهل باقي الأصوات (جرس - انفجار) ولا تضغط على أي زر.",
            'auditory-choice': "ستسمع مثيرات سمعية مختلفة، ولكل مثير زر استجابة محدد.<br>استخدم دليل الاستجابة الظاهر قبل بدء الاختبار واضغط الزر المطابق للصوت بأسرع ما يمكن."
        },
        stimuli: {
            visualSimple: {
                targets: [{ id: 'green', type: 'color', val: '#2ed573', label: 'أخضر', shape: 'circle' }],
                distractors: []
            },
            visualDiscriminative: {
                targets: [{ id: 'green', type: 'color', val: '#2ed573', label: 'أخضر', shape: 'circle' }],
                distractors: [
                    { id: 'red', type: 'color', val: '#ff4757', label: 'أحمر', shape: 'circle' },
                    { id: 'blue', type: 'color', val: '#1e90ff', label: 'أزرق', shape: 'circle' },
                    { id: 'yellow', type: 'color', val: '#ffd700', label: 'أصفر', shape: 'circle' }
                ]
            },
            visualChoice: {
                targets: [
                    { id: 'green', type: 'color', val: '#2ed573', label: 'أخضر', shape: 'circle', key: 'ArrowUp', keyLabel: '↑' },
                    { id: 'blue', type: 'color', val: '#1e90ff', label: 'أزرق', shape: 'circle', key: 'ArrowDown', keyLabel: '↓' },
                    { id: 'yellow', type: 'color', val: '#ffd700', label: 'أصفر', shape: 'circle', key: 'ArrowRight', keyLabel: '→' }
                ],
                distractors: []
            },
            auditorySimple: {
                targets: [{ id: 'buzzer', type: 'sound', val: 'buzzer', label: 'صفارة' }],
                distractors: []
            },
            auditoryDiscriminative: {
                targets: [{ id: 'buzzer', type: 'sound', val: 'buzzer', label: 'صفارة' }],
                distractors: [
                    { id: 'bell', type: 'sound', val: 'bell', label: 'جرس' },
                    { id: 'explosion', type: 'sound', val: 'explosion', label: 'انفجار' }
                ]
            },
            auditoryChoice: {
                targets: [
                    { id: 'buzzer', type: 'sound', val: 'buzzer', label: 'صفارة', key: 'KeyA', keyLabel: 'A' },
                    { id: 'bell', type: 'sound', val: 'bell', label: 'جرس', key: 'KeyB', keyLabel: 'B' },
                    { id: 'alert', type: 'sound', val: 'alert', label: 'تنبيه', key: 'KeyC', keyLabel: 'C' }
                ],
                distractors: []
            }
        }
    }
};

const DEFAULT_GENERAL_SETTINGS = Object.freeze({
    trialsCount: 20,
    practiceEnabled: true,
    practiceTrialsCount: 3,
    practiceOpenEnded: false,
    practiceFeedback: true,
    testFeedback: false,
    minLatency: 0.5,
    maxLatency: 3.0,
    stimulusDuration: 1.0,
    interStimulus: 1.0,
    maxResponseTime: 3.0,
    randomOrder: true
});

const DEFAULT_INSTRUCTIONS = Object.freeze(deepClone(state.settings.instructions));

const TEST_TYPES = [
    'visual-simple',
    'visual-discriminative',
    'visual-choice',
    'auditory-simple',
    'auditory-discriminative',
    'auditory-choice'
];

const MAX_CHOICE_TARGETS = 3;

function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
}

function makeEntityId(prefix) {
    const unique = globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    return `${prefix}_${unique}`;
}

function makeStudentCode(id) {
    const compact = String(id || '').replace(/[^a-zA-Z0-9]/g, '').slice(-8).toUpperCase();
    return `STU-${compact || Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function sanitizeInstructionHtml(value) {
    return escapeHtml(value)
        .replace(/&lt;br\s*\/?&gt;/gi, '<br>')
        .replace(/&lt;(\/)?(b|strong|ul|ol|li)&gt;/gi, '<$1$2>');
}

function safeNumber(value, fallback = null) {
    if (value === null || value === undefined || String(value).trim() === '') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function describePointer(event) {
    if (event?.pointerType === 'touch') return 'touch';
    if (event?.pointerType === 'pen') return 'pen';
    return 'mouse';
}

function collectDeviceInfo() {
    return {
        userAgent: navigator.userAgent || '',
        platform: navigator.userAgentData?.platform || navigator.platform || '',
        screen: `${window.screen?.width || 0}×${window.screen?.height || 0}`,
        viewport: `${window.innerWidth || 0}×${window.innerHeight || 0}`,
        pixelRatio: window.devicePixelRatio || 1,
        touchPoints: navigator.maxTouchPoints || 0
    };
}

function translateInputMethod(method) {
    const labels = { keyboard: 'لوحة المفاتيح', touch: 'شاشة لمس', mouse: 'فأرة', pen: 'قلم رقمي', mixed: 'طرق متعددة', unknown: 'غير مسجل' };
    return labels[method] || method || 'غير مسجل';
}

function milliseconds(seconds, fallback = 0) {
    const value = Number(seconds);
    return Number.isFinite(value) ? Math.round(value * 1000) : fallback;
}

function showDataStatus(message, type = 'warning') {
    let banner = document.getElementById('dataStatusBanner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'dataStatusBanner';
        banner.className = 'data-status-banner';
        banner.setAttribute('role', 'status');
        document.body?.appendChild(banner);
    }
    banner.className = `data-status-banner ${type}`;
    banner.textContent = message;
    banner.hidden = false;
    window.setTimeout(() => { banner.hidden = true; }, 6000);
}

function sharedCollection(name) {
    return useFirebase && db && firebaseUser ? db.collection(name) : null;
}

function persistPendingDeletions() {
    localStorage.setItem('sensory_pending_deletions', JSON.stringify(pendingDeletions));
}

function markPendingDeletion(collectionName, id) {
    if (!pendingDeletions[collectionName] || !id) return;
    pendingDeletions[collectionName][id] = new Date().toISOString();
    persistPendingDeletions();
}

function clearPendingDeletion(collectionName, id) {
    if (!pendingDeletions[collectionName]?.[id]) return;
    delete pendingDeletions[collectionName][id];
    persistPendingDeletions();
}

async function flushPendingDeletions() {
    if (!useFirebase || !db || !firebaseUser) return;
    for (const collectionName of ['students', 'sessions']) {
        for (const id of Object.keys(pendingDeletions[collectionName] || {})) {
            await db.collection('deletions').doc(`${collectionName}__${id}`).set({
                collectionName,
                recordId: id,
                deletedAt: new Date().toISOString()
            });
            await db.collection(collectionName).doc(id).delete();
            sharedDeletedIds[collectionName].add(id);
            clearPendingDeletion(collectionName, id);
        }
    }
}

function mergeRecordsById(localRecords, remoteRecords) {
    const merged = new Map();
    [...localRecords, ...remoteRecords].forEach(record => {
        if (!record?.id) return;
        const existing = merged.get(record.id);
        if (!existing) {
            merged.set(record.id, record);
            return;
        }
        const existingTime = new Date(existing.updatedAt || existing.date || existing.createdAt || 0).getTime();
        const candidateTime = new Date(record.updatedAt || record.date || record.createdAt || 0).getTime();
        if (candidateTime >= existingTime) merged.set(record.id, { ...existing, ...record });
    });
    return [...merged.values()];
}

function touchSettings() {
    state.settings.updatedAt = new Date().toISOString();
}

function mean(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function median(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function sampleStdDev(values) {
    if (values.length < 2) return null;
    const avg = mean(values);
    const variance = values.reduce((sum, value) => sum + Math.pow(value - avg, 2), 0) / (values.length - 1);
    return Math.sqrt(variance);
}

function getSessionMaxResponseTime(session) {
    const configuredLimit = [
        session?.settingsSnapshot?.general?.maxResponseTime,
        session?.maxResponseTime
    ]
        .map(value => safeNumber(value, null))
        .find(value => value !== null && value > 0);
    return configuredLimit ?? null;
}

function getTrialAnalysisCategory(trial, session) {
    const result = trial?.result;
    const latency = safeNumber(trial?.latency, null);
    const maxResponseTime = getSessionMaxResponseTime(session);

    if (result === 'early') return 'early';
    if (latency !== null && maxResponseTime !== null && latency > maxResponseTime) return 'late';
    if (result === 'miss') return 'miss';
    if (result === 'correct' || result === 'correct-rejection') return 'correct';
    if (result === 'wrong' || result === 'false-alarm') return 'wrong';
    return 'wrong';
}

function getTrialCalculationStatus(trial, session) {
    const category = getTrialAnalysisCategory(trial, session);
    if (category === 'late') return 'مستبعدة: تجاوزت الحد الزمني المحدد';
    if (category === 'early') return 'مستبعدة: استجابة مبكرة';
    if (category === 'miss') return 'مستبعدة: استجابة فائتة';
    if (category === 'wrong') return 'مستبعدة: استجابة خاطئة';
    if (trial?.result === 'correct-rejection') return 'مستبعدة من الزمن: تجاهل صحيح دون ضغط';
    return 'محتسبة في المجموع والمتوسط والانحراف المعياري';
}

function getCorrectReactionTimes(session) {
    const maxResponseTime = getSessionMaxResponseTime(session);
    return (session.trials || [])
        .filter(trial => {
            const latency = safeNumber(trial.latency, null);
            return trial.result === 'correct'
                && latency !== null
                && latency >= 0
                && (maxResponseTime === null || latency <= maxResponseTime);
        })
        .map(trial => Number(trial.latency));
}

function normalizeSession(session) {
    const trials = Array.isArray(session.trials) ? session.trials : [];
    const practiceTrials = Array.isArray(session.practiceTrials) ? session.practiceTrials : [];
    const trialsCount = safeNumber(session.trialsCount, trials.length || 0);
    const correctRejectionCount = safeNumber(session.correctRejectionCount,
        trials.filter(trial => trial.result === 'correct-rejection' || (trial.result === 'correct' && trial.requiredKey === 'ignore' && !trial.actualKey)).length);
    const responseCorrectCount = safeNumber(session.responseCorrectCount,
        trials.filter(trial => trial.result === 'correct' && trial.requiredKey !== 'ignore').length);
    const legacyCorrect = safeNumber(session.correctCount, responseCorrectCount + correctRejectionCount);
    const correctCount = Math.max(legacyCorrect, responseCorrectCount + correctRejectionCount);
    const wrongChoiceCount = safeNumber(session.wrongChoiceCount,
        trials.filter(trial => trial.result === 'wrong').length);
    const falseAlarmCount = safeNumber(session.falseAlarmCount,
        trials.filter(trial => trial.result === 'false-alarm').length);
    const earlyCount = safeNumber(session.earlyCount,
        trials.filter(trial => trial.result === 'early').length);
    const legacyWrong = safeNumber(session.wrongCount, wrongChoiceCount + falseAlarmCount + earlyCount);
    const missCount = safeNumber(session.missCount,
        trials.filter(trial => trial.result === 'miss').length);
    const lateCount = trials.filter(trial => getTrialAnalysisCategory(trial, session) === 'late').length;
    const correctLatencies = getCorrectReactionTimes({ ...session, trials });
    const hasTrialDetails = trials.length > 0;
    const avgReactionTime = correctLatencies.length
        ? mean(correctLatencies)
        : (hasTrialDetails ? 0 : safeNumber(session.avgReactionTime, 0));
    const medianReactionTime = correctLatencies.length
        ? median(correctLatencies)
        : (hasTrialDetails ? 0 : safeNumber(session.medianReactionTime, avgReactionTime));
    const stdDevReactionTime = correctLatencies.length >= 2
        ? sampleStdDev(correctLatencies)
        : (hasTrialDetails ? null : safeNumber(session.stdDevReactionTime, null));
    const errorCount = Math.max(0, trialsCount - correctCount);

    return {
        ...session,
        trials,
        practiceTrials,
        trialsCount,
        practiceTrialsCount: safeNumber(session.practiceTrialsCount, practiceTrials.length),
        responseCorrectCount,
        correctRejectionCount,
        correctCount,
        wrongChoiceCount,
        wrongCount: safeNumber(session.wrongCount, legacyWrong),
        falseAlarmCount,
        earlyCount,
        lateCount,
        missCount,
        errorCount,
        avgReactionTime,
        medianReactionTime,
        stdDevReactionTime,
        fastestTime: correctLatencies.length ? Math.min(...correctLatencies) : (hasTrialDetails ? 0 : safeNumber(session.fastestTime, 0)),
        slowestTime: correctLatencies.length ? Math.max(...correctLatencies) : (hasTrialDetails ? 0 : safeNumber(session.slowestTime, 0)),
        accuracy: trialsCount ? (correctCount / trialsCount) * 100 : 0,
        errorRate: trialsCount ? (errorCount / trialsCount) * 100 : 0,
        studentCategory: session.studentCategory || ''
    };
}

function migrateLoadedState() {
    state.settings = state.settings || {};
    state.settings.general = { ...DEFAULT_GENERAL_SETTINGS, ...(state.settings.general || {}) };
    state.settings.instructions = state.settings.instructions || {};
    state.settings.stimuli = state.settings.stimuli || deepClone(DEFAULT_STIMULI);
    ['visualChoice', 'auditoryChoice'].forEach(testType => {
        const config = state.settings.stimuli[testType] || deepClone(DEFAULT_STIMULI[testType]);
        config.distractors = [];
        if (!Array.isArray(config.targets) || !config.targets.length) {
            config.targets = deepClone(DEFAULT_STIMULI[testType].targets.slice(0, 1));
        } else if (config.targets.length > MAX_CHOICE_TARGETS) {
            config.targets = config.targets.slice(0, MAX_CHOICE_TARGETS);
        }
        state.settings.stimuli[testType] = config;
    });
    state.students = (state.students || []).map(student => {
        const id = student.id || makeEntityId('student');
        return {
            category: '',
            ...student,
            id,
            code: student.code || makeStudentCode(id),
            updatedAt: student.updatedAt || student.createdAt || new Date().toISOString()
        };
    });
    const studentsById = new Map(state.students.map(student => [student.id, student]));
    state.sessions = (state.sessions || []).map(item => {
        const session = normalizeSession(item);
        const student = studentsById.get(session.studentId);
        return {
            ...session,
            studentCode: session.studentCode || student?.code || '',
            updatedAt: session.updatedAt || session.date || new Date().toISOString()
        };
    });
}

// Global chart references
let rptAccuracyDonutChart = null;
let rptResponseTimelineChart = null;
let rptStimulusBarChart = null;
let dbAccuracyChart = null;
let dbReactionTrendChart = null;
let clinicalSaveTimer = null;

// Initializer Function
document.addEventListener("DOMContentLoaded", () => {
    loadData();
    initRouter();
    initGeneralEventListeners();
    updateUI();
    initSettingsForms();
});

// Load and Save to LocalStorage & Firebase Firestore (Hybrid Sync)
function loadData() {
    try {
        const cachedStudents = localStorage.getItem("sensory_students");
        const cachedSessions = localStorage.getItem("sensory_sessions");
        const cachedSettings = localStorage.getItem("sensory_settings");
        const cachedDeletions = localStorage.getItem('sensory_pending_deletions');

        if (cachedStudents) state.students = JSON.parse(cachedStudents);
        if (cachedSessions) state.sessions = JSON.parse(cachedSessions);
        if (cachedDeletions) {
            const loadedDeletions = JSON.parse(cachedDeletions);
            pendingDeletions = {
                students: loadedDeletions.students || {},
                sessions: loadedDeletions.sessions || {}
            };
        }
        if (cachedSettings) {
            const loadedSettings = JSON.parse(cachedSettings);
            state.settings = {
                ...state.settings,
                ...loadedSettings,
                general: { ...state.settings.general, ...(loadedSettings.general || {}) },
                instructions: { ...state.settings.instructions, ...(loadedSettings.instructions || {}) },
                stimuli: { ...state.settings.stimuli, ...(loadedSettings.stimuli || {}) }
            };
        }

        migrateLoadedState();

        // Set default active student if exists
        if (state.students.length > 0) {
            state.activeStudentId = state.students[0].id;
        }
    } catch (e) {
        console.error("Error reading localStorage", e);
    }

    // Authenticate first, then merge cloud and device records by durable IDs.
    firebaseReady.then(user => {
        if (user) syncFromFirestore();
    });
}

function saveData() {
    try {
        localStorage.setItem("sensory_students", JSON.stringify(state.students));
        localStorage.setItem("sensory_sessions", JSON.stringify(state.sessions));
        localStorage.setItem("sensory_settings", JSON.stringify(state.settings));
        persistPendingDeletions();
    } catch (e) {
        console.error("Error saving data to localStorage", e);
        showDataStatus('مساحة التخزين على الجهاز ممتلئة. صدّر نسخة Excel قبل إضافة بيانات جديدة.', 'error');
    }

    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncAllToFirestore, 650);
}

function startSharedRealtimeSync() {
    if (!db || sharedRealtimeUnsubscribers.length) return;
    const refresh = () => {
        clearTimeout(sharedRefreshTimer);
        sharedRefreshTimer = setTimeout(() => syncFromFirestore(false), 350);
    };
    ['students', 'sessions', 'deletions', 'appData'].forEach(collectionName => {
        sharedRealtimeUnsubscribers.push(db.collection(collectionName).onSnapshot(refresh, error => {
            console.warn(`Realtime sync unavailable for ${collectionName}:`, error?.code || error);
        }));
    });
}

async function syncFromFirestore(writeBack = true) {
    if (!useFirebase || !db || !firebaseUser) return;
    try {
        const legacyRoot = db.collection('users').doc(firebaseUser.uid);
        const [settingsDoc, studentsSnapshot, sessionsSnapshot, deletionsSnapshot, legacySettingsDoc, legacyStudentsSnapshot, legacySessionsSnapshot] = await Promise.all([
            db.collection('appData').doc('settings').get(),
            sharedCollection('students').get(),
            sharedCollection('sessions').get(),
            sharedCollection('deletions').get(),
            legacyRoot.collection('private').doc('settings').get(),
            legacyRoot.collection('students').get(),
            legacyRoot.collection('sessions').get()
        ]);
        const availableSettingsDoc = settingsDoc.exists ? settingsDoc : legacySettingsDoc;
        if (availableSettingsDoc.exists) {
            const remoteSettings = availableSettingsDoc.data();
            const remoteTime = new Date(remoteSettings.updatedAt || 0).getTime();
            const localTime = new Date(state.settings.updatedAt || 0).getTime();
            if (remoteTime >= localTime) {
                state.settings = {
                    ...state.settings,
                    ...remoteSettings,
                    general: { ...state.settings.general, ...(remoteSettings.general || {}) },
                    instructions: { ...state.settings.instructions, ...(remoteSettings.instructions || {}) },
                    stimuli: { ...state.settings.stimuli, ...(remoteSettings.stimuli || {}) }
                };
            }
        }
        const remoteStudents = [];
        studentsSnapshot.forEach(doc => remoteStudents.push({ ...doc.data(), id: doc.id }));
        legacyStudentsSnapshot.forEach(doc => remoteStudents.push({ ...doc.data(), id: doc.id }));
        const remoteSessions = [];
        sessionsSnapshot.forEach(doc => remoteSessions.push({ ...doc.data(), id: doc.id }));
        legacySessionsSnapshot.forEach(doc => remoteSessions.push({ ...doc.data(), id: doc.id }));
        sharedDeletedIds.students.clear();
        sharedDeletedIds.sessions.clear();
        deletionsSnapshot.forEach(doc => {
            const deletion = doc.data();
            if (sharedDeletedIds[deletion.collectionName] && deletion.recordId) {
                sharedDeletedIds[deletion.collectionName].add(deletion.recordId);
            }
        });
        const allowedRemoteStudents = remoteStudents.filter(student => !pendingDeletions.students[student.id] && !sharedDeletedIds.students.has(student.id));
        const allowedRemoteSessions = remoteSessions.filter(session => !pendingDeletions.sessions[session.id] && !sharedDeletedIds.sessions.has(session.id));
        const allowedLocalStudents = state.students.filter(student => !sharedDeletedIds.students.has(student.id));
        const allowedLocalSessions = state.sessions.filter(session => !sharedDeletedIds.sessions.has(session.id));
        state.students = mergeRecordsById(allowedLocalStudents, allowedRemoteStudents);
        state.sessions = mergeRecordsById(allowedLocalSessions, allowedRemoteSessions).map(normalizeSession);
        migrateLoadedState();
        await migrateEmbeddedStimuliToStorage();
        localStorage.setItem('sensory_students', JSON.stringify(state.students));
        localStorage.setItem('sensory_sessions', JSON.stringify(state.sessions));
        localStorage.setItem('sensory_settings', JSON.stringify(state.settings));
        if (!state.activeStudentId || !state.students.some(student => student.id === state.activeStudentId)) {
            state.activeStudentId = state.students[0]?.id || null;
        }
        initSettingsForms();
        updateUI();
        populateSessionsList();
        startSharedRealtimeSync();
        if (writeBack) syncAllToFirestore();
    } catch (error) {
        console.error('Secure cloud sync failed:', error);
        showDataStatus('تعذرت المزامنة السحابية. ستظل البيانات محفوظة على هذا الجهاز.', 'warning');
    }
}

async function syncAllToFirestore() {
    await firebaseReady;
    if (!useFirebase || !db || !firebaseUser) return;
    try {
        await flushPendingDeletions();
        const students = state.students.filter(student => !sharedDeletedIds.students.has(student.id));
        const sessions = state.sessions.filter(session => !sharedDeletedIds.sessions.has(session.id));
        const writes = [
            { ref: db.collection('appData').doc('settings'), data: state.settings },
            ...students.map(student => ({ ref: db.collection('students').doc(student.id), data: student })),
            ...sessions.map(session => ({ ref: db.collection('sessions').doc(session.id), data: session }))
        ];
        for (let index = 0; index < writes.length; index += 400) {
            const batch = db.batch();
            writes.slice(index, index + 400).forEach(write => batch.set(write.ref, write.data, { merge: true }));
            await batch.commit();
        }
    } catch (error) {
        console.error('Secure cloud save failed:', error);
        showDataStatus('لم تكتمل المزامنة السحابية؛ الحفظ المحلي ما زال يعمل.', 'warning');
    }
}

async function deleteRemoteRecord(collectionName, id) {
    markPendingDeletion(collectionName, id);
    await firebaseReady;
    if (!db || !id) return;
    try {
        await flushPendingDeletions();
    } catch (error) {
        console.error(`Failed deleting ${collectionName}/${id}:`, error);
        showDataStatus('تم الحذف محليًا، لكن تعذر تأكيد الحذف السحابي.', 'warning');
    }
}

function deleteStudentRecord(id) {
    const relatedSessionIds = state.sessions.filter(session => session.studentId === id).map(session => session.id);
    state.students = state.students.filter(student => student.id !== id);
    state.sessions = state.sessions.filter(session => session.studentId !== id);
    if (state.activeStudentId === id) state.activeStudentId = state.students[0]?.id || null;
    if (state.activeSession?.studentId === id) state.activeSession = null;
    saveData();
    updateUI();
    populateSessionsList();
    deleteRemoteRecord('students', id);
    relatedSessionIds.forEach(sessionId => deleteRemoteRecord('sessions', sessionId));
}

// Router & View Switcher
function initRouter() {
    const navItems = document.querySelectorAll(".nav-item, .nav-link-btn");
    navItems.forEach(item => {
        item.addEventListener("click", (e) => {
            e.preventDefault();
            const target = item.getAttribute("data-target");
            switchView(target);
        });
    });
}

function switchView(viewId) {
    // Hide all screens
    document.querySelectorAll(".view-screen").forEach(screen => {
        screen.classList.remove("active-screen");
    });

    // Remove active class from menu
    document.querySelectorAll(".nav-item").forEach(nav => {
        nav.classList.remove("active");
        if (nav.getAttribute("data-target") === viewId) {
            nav.classList.add("active");
        }
    });

    // Show selected screen
    const targetScreen = document.getElementById(viewId);
    if (targetScreen) {
        targetScreen.classList.add("active-screen");
    }

    // Contextual actions
    if (viewId === 'home-view') {
        renderDashboardCharts();
    } else if (viewId === 'results-view') {
        populateSessionsList();
    }
}

// General UI Update
function updateUI() {

    // Render Latest Results Table on Dashboard
    const latestResultsBody = document.getElementById("dashboardLatestResultsBody");
    if (latestResultsBody) {
        latestResultsBody.innerHTML = "";
        const sortedSessions = [...state.sessions].sort((a,b) => new Date(b.date) - new Date(a.date)).slice(0, 5);
        
        sortedSessions.forEach(session => {
            const student = state.students.find(s => s.id === session.studentId) || { name: session.studentName };
            const testNameAr = getTestArabicName(session.testType);
            const formattedDate = new Date(session.date).toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' });
            
            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td><strong>${escapeHtml(student.name)}</strong></td>
                <td>${escapeHtml(testNameAr)}</td>
                <td>${escapeHtml(formattedDate)}</td>
                <td>${escapeHtml(session.avgReactionTime)} ثانية</td>
                <td><span class="badge-status correct">${Math.round((session.correctCount/session.trialsCount)*100)}% دقة</span></td>
            `;
            latestResultsBody.appendChild(tr);
        });
    }
    renderDashboardCharts();
}

// Map technical test key to Arabic name
function getTestArabicName(type) {
    const map = {
        'visual-simple': 'البصري البسيط',
        'visual-discriminative': 'البصري التمييزي',
        'visual-choice': 'البصري الاختياري',
        'auditory-simple': 'السمعي البسيط',
        'auditory-discriminative': 'السمعي التمييزي',
        'auditory-choice': 'السمعي الاختياري'
    };
    return map[type] || type;
}

// General Event Listeners (Sidebar, Profile, etc.)
function initGeneralEventListeners() {
    // Night Mode Toggle
    document.getElementById("nightModeBtn")?.addEventListener("click", () => {
        document.body.classList.toggle("dark-mode");
        document.body.classList.toggle("light-mode");
        
        // Re-render charts to fit the color theme
        renderDashboardCharts();
        if (state.activeSession) {
            renderReportCharts(state.activeSession);
        }
    });

    // Cloud Status Info Popup
    document.getElementById("cloudStatusBadge")?.addEventListener("click", () => {
        const info = lastCloudStatus.detail ? `\n\nتفاصيل: ${lastCloudStatus.detail}` : '';
        if (lastCloudStatus.status === 'connected') {
            alert(`🟢 المزامنة السحابية مفعّلة ومتصلة بنجاح!\nتتم مشاركة نتائج الاختبارات والمشاركين تلقائياً على كافة الأجهزة المقترنة.${info}`);
        } else if (lastCloudStatus.status === 'error') {
            alert(`🔴 خطأ المزامنة السحابية:\n${lastCloudStatus.title}${info}\n\nخطوات الحل:\n1. افتح موقع Firebase Console للمشروع srt-id-ba9e8\n2. اذهب إلى Authentication -> Sign-in method\n3. قم بتفعيل خيار "Anonymous"\n4. اذهب إلى Firestore Database -> Rules وقم بنشر قواعد الملف firestore.rules.`);
        } else {
            alert(`ℹ️ حالة الاتصال بالسحابة:\n${lastCloudStatus.title}${info}`);
        }
    });


    // Launch Test buttons in Grid (legacy - kept for home dashboard quick launch)
    document.addEventListener("click", (e) => {
        const btn = e.target.closest(".launch-test-btn");
        if (!btn) return;
        const testType = btn.getAttribute("data-test-type");
        
        // Build a quick student from activeStudentId if available
        let qs = state.sessionStudent;
        if (!qs && state.activeStudentId) {
            const st = state.students.find(s => s.id === state.activeStudentId);
            if (st) qs = { ...st };
        }
        if (!qs) {
            const id = makeEntityId('student');
            const anonymousStudent = {
                id,
                code: makeStudentCode(id),
                name: `حالة غير مسماة #${String(Date.now()).slice(-6)}`,
                age: null,
                gender: '',
                iq: null,
                category: '',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };
            state.students.push(anonymousStudent);
            state.activeStudentId = anonymousStudent.id;
            qs = anonymousStudent;
            saveData();
        }
        state.sessionStudent = qs;
        state.testQueue = [testType];
        startNextTestFromQueue();
    });

    // ===================== Tests-View Form Handlers =====================
    // Select all / Clear all test checkboxes
    document.getElementById("selectAllTestsBtn")?.addEventListener("click", () => {
        document.querySelectorAll(".test-checkbox").forEach(cb => cb.checked = true);
    });
    document.getElementById("clearAllTestsBtn")?.addEventListener("click", () => {
        document.querySelectorAll(".test-checkbox").forEach(cb => cb.checked = false);
    });
    document.querySelectorAll('.select-modality-btn').forEach(button => {
        button.addEventListener('click', () => {
            const prefix = button.dataset.prefix || '';
            const checkboxes = [...document.querySelectorAll(`.test-checkbox[value^="${prefix}"]`)];
            const shouldSelect = checkboxes.some(checkbox => !checkbox.checked);
            checkboxes.forEach(checkbox => { checkbox.checked = shouldSelect; });
            button.textContent = shouldSelect
                ? (prefix === 'visual-' ? 'إلغاء البصرية' : 'إلغاء السمعية')
                : (prefix === 'visual-' ? 'تحديد البصرية' : 'تحديد السمعية');
        });
    });

    // Start session button
    document.getElementById("startTestsSessionBtn")?.addEventListener("click", () => {
        const enteredName = document.getElementById("tsStudentName")?.value.trim() || '';
        const age = safeNumber(document.getElementById("tsStudentAge")?.value, null);
        const gender = document.getElementById("tsStudentGender")?.value;
        const iq = safeNumber(document.getElementById("tsStudentIQ")?.value, null);
        const category = document.getElementById("tsStudentCategory")?.value || '';

        const specName = document.getElementById("tsSpecialistName")?.value.trim() || '';
        const specTitle = document.getElementById("tsSpecialistTitle")?.value.trim() || '';
        const center = document.getElementById("tsCenter")?.value.trim() || '';
        const sessionDate = document.getElementById("tsSessionDate")?.value;

        const selectedTests = Array.from(document.querySelectorAll(".test-checkbox:checked")).map(cb => cb.value);
        if (selectedTests.length === 0) { alert("يرجى تحديد اختبار واحد على الأقل."); return; }
        if (age !== null && (age < 1 || age > 120)) { alert('العمر يجب أن يكون بين سنة و120 سنة.'); return; }
        if (iq !== null && (iq < 30 || iq > 160)) { alert('نسبة الذكاء يجب أن تكون بين 30 و160.'); return; }

        // Create a fresh hidden identifier for this battery. Names are never used as record keys.
        const id = makeEntityId('student');
        const existingStudent = {
            id,
            code: makeStudentCode(id),
            name: enteredName || `حالة غير مسماة #${String(Date.now()).slice(-6)}`,
            age,
            gender: gender || '',
            iq,
            category,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        state.students.push(existingStudent);
        
        state.activeStudentId = existingStudent.id;
        state.sessionStudent = { ...existingStudent };
        const now = new Date();
        const applicationDate = sessionDate
            ? new Date(`${sessionDate}T${now.toTimeString().slice(0, 8)}`).toISOString()
            : now.toISOString();
        state.sessionSpecialist = (specName || specTitle || center || sessionDate)
            ? { name: specName, title: specTitle, center, date: applicationDate }
            : null;
        state.testQueue = [...selectedTests];
        
        saveData();
        updateUI();

        startNextTestFromQueue();
    });

    // Stimuli Library items sounds click
    document.querySelectorAll(".sound-item").forEach(item => {
        item.addEventListener("click", () => {
            const soundName = item.getAttribute("data-sound");
            window.appAudio.playSoundByName(soundName);
        });
    });

    // Report Actions: Print / PDF
    document.getElementById("printReportBtn")?.addEventListener("click", () => {
        prepareClinicalNotesForPrint();
        window.print();
    });
    
    document.getElementById("pdfReportBtn")?.addEventListener("click", () => {
        prepareClinicalNotesForPrint();
        window.print();
    });

    document.getElementById("shareReportBtn")?.addEventListener("click", async () => {
        if (!state.activeSession) return;
        const student = state.students.find(s => s.id === state.activeSession.studentId) || { name: state.activeSession.studentName };
        const testName = getTestArabicName(state.activeSession.testType);
        const shareText = `تقرير اختبار الرجع الحسي: \nالطفل: ${student.name}\nالاختبار: ${testName}\nمتوسط زمن الرجع: ${state.activeSession.avgReactionTime} ثانية\nالدقة: ${Math.round((state.activeSession.correctCount/state.activeSession.trialsCount)*100)}%`;
        try {
            if (navigator.share) await navigator.share({ title: 'تقرير مقياس زمن الرجع الحسي', text: shareText });
            else if (navigator.clipboard) {
                await navigator.clipboard.writeText(shareText);
                alert('تم نسخ ملخص التقرير ويمكنك مشاركته الآن.');
            } else alert(shareText);
        } catch (error) {
            if (error?.name !== 'AbortError') showDataStatus('تعذرت المشاركة من هذا المتصفح.', 'warning');
        }
    });

    // Group Report Actions
    document.getElementById("printGroupReportBtn")?.addEventListener("click", () => {
        window.print();
    });
    
    document.getElementById("pdfGroupReportBtn")?.addEventListener("click", () => {
        window.print();
    });

    document.getElementById("exportGroupExcelBtn")?.addEventListener("click", () => {
        const sessions = getFilteredGroupSessions();
        if (!sessions.length) {
            alert("لا توجد نتائج جماعية مطابقة لعوامل التصفية الحالية.");
            return;
        }
        const testFilter = document.getElementById('cfgGroupTestType')?.value || '';
        const visualSheet = buildWideModalitySheet(sessions, 'visual');
        const auditorySheet = buildWideModalitySheet(sessions, 'auditory');
        downloadExcelWorkbook("التقرير_الجماعي_لمقياس_زمن_الرجع", [
            { name: 'التقرير الجماعي', rows: buildGroupExcelRows(sessions, testFilter) },
            { name: 'إجماليات المحاولات', rows: buildGroupTrialsTotalsRows(sessions, testFilter) },
            { name: 'تفاصيل محاولات الطلاب', rows: buildGroupTrialDetailsRows(sessions) },
            visualSheet,
            auditorySheet
        ]);
    });

    ['cfgGroupDateFrom', 'cfgGroupDateTo', 'cfgGroupGender', 'cfgGroupAgeFrom', 'cfgGroupAgeTo', 'cfgGroupTestType', 'cfgGroupCategory', 'cfgGroupIQFrom', 'cfgGroupIQTo']
        .forEach(id => document.getElementById(id)?.addEventListener('change', loadGroupReport));

    // Save Clinical Notes in Report dynamically
    document.getElementById("rptClinicalNotes")?.addEventListener("input", (e) => {
        if (state.activeSession) {
            state.activeSession.clinicalNotes = e.target.value;
            const sessionIndex = state.sessions.findIndex(s => s.id === state.activeSession.id);
            if (sessionIndex !== -1) {
                state.sessions[sessionIndex].clinicalNotes = e.target.value;
                state.sessions[sessionIndex].updatedAt = new Date().toISOString();
                clearTimeout(clinicalSaveTimer);
                clinicalSaveTimer = setTimeout(saveData, 600);
            }
        }
    });

    // Delete Session Action
    document.getElementById("deleteSessionBtn")?.addEventListener("click", () => {
        if (!state.activeSession) return;
        if (confirm("هل أنت متأكد من حذف هذه الجلسة نهائياً؟")) {
            const sessionId = state.activeSession.id;
            state.sessions = state.sessions.filter(s => s.id !== sessionId);
            state.activeSession = null;

            saveData();
            deleteRemoteRecord('sessions', sessionId);
            updateUI(); // Updates home stats, charts, and tables

            // Reset report view
            const placeholder = document.getElementById("noSessionPlaceholder");
            const reportArea = document.getElementById("reportDocumentArea");
            if (placeholder) placeholder.style.display = "flex";
            if (reportArea) reportArea.style.display = "none";

            const deleteBtn = document.getElementById("deleteSessionBtn");
            if (deleteBtn) deleteBtn.style.display = "none";

            // Re-populate history dropdown list
            populateSessionsList();
        }
    });

    // Individual results: student selector and all-test cards.
    document.getElementById("historyStudentSelect")?.addEventListener("change", (event) => {
        const studentId = event.target.value;
        state.activeStudentId = studentId || state.activeStudentId;
        state.activeSession = null;
        renderStudentTestsOverview(studentId);
        populateSessionOptions(studentId);

        const placeholder = document.getElementById("noSessionPlaceholder");
        const reportArea = document.getElementById("reportDocumentArea");
        if (placeholder) placeholder.style.display = studentId ? "none" : "flex";
        if (reportArea) reportArea.style.display = "none";
        const deleteBtn = document.getElementById("deleteSessionBtn");
        if (deleteBtn) deleteBtn.style.display = "none";
        const deleteStudentButton = document.getElementById('deleteStudentBtn');
        if (deleteStudentButton) deleteStudentButton.style.display = studentId ? 'inline-flex' : 'none';
    });

    document.getElementById('deleteStudentBtn')?.addEventListener('click', () => {
        const studentId = document.getElementById('historyStudentSelect')?.value;
        const student = state.students.find(item => item.id === studentId);
        if (!student) return;
        if (!confirm(`هل تريد حذف ${student.name || 'هذا الطالب'} وكل جلساته نهائيًا؟`)) return;
        deleteStudentRecord(studentId);
    });

    document.getElementById("studentTestResultsGrid")?.addEventListener("click", (event) => {
        const button = event.target.closest(".open-student-session-btn");
        if (!button) return;
        const session = state.sessions.find(item => item.id === button.dataset.sessionId);
        if (!session) return;
        const select = document.getElementById("historySessionSelect");
        if (select) select.value = session.id;
        loadSessionReport(session);
        document.getElementById("reportDocumentArea")?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    // History Session Selector bar
    document.getElementById("historySessionSelect")?.addEventListener("change", (e) => {
        const val = e.target.value;
        if (!val) {
            const placeholder = document.getElementById("noSessionPlaceholder");
            const reportArea = document.getElementById("reportDocumentArea");
            if(placeholder) placeholder.style.display = "flex";
            if(reportArea) reportArea.style.display = "none";
            state.activeSession = null;
            
            const deleteBtn = document.getElementById("deleteSessionBtn");
            if (deleteBtn) deleteBtn.style.display = "none";
            return;
        }
        const session = state.sessions.find(s => s.id === val);
        if (session) {
            loadSessionReport(session);
        }
    });

    document.getElementById("exportCurrentSessionExcelBtn")?.addEventListener("click", () => {
        if (!state.activeSession) {
            alert("اختر جلسة أولاً لتصديرها.");
            return;
        }
        exportSessionsToExcel([state.activeSession], `جلسة_${state.activeSession.studentName || 'غير_مسماة'}`);
    });

    document.getElementById("exportStudentExcelBtn")?.addEventListener("click", () => {
        const studentId = document.getElementById("historyStudentSelect")?.value;
        const student = state.students.find(item => item.id === studentId);
        if (!student) {
            alert("اختر طالبًا أولاً لتصدير جميع نتائجه.");
            return;
        }
        exportSessionsToExcel(getSessionsForStudent(student), `نتائج_${student.name || 'حالة_غير_مسماة'}`, [student]);
    });

    document.getElementById("exportAllExcelBtn")?.addEventListener("click", () => {
        if (!state.sessions.length) {
            alert("لا توجد نتائج لتصديرها.");
            return;
        }
        exportSessionsToExcel(state.sessions, "جميع_نتائج_مقياس_زمن_الرجع", state.students);
    });

    // Results Tab Switching Logic
    document.getElementById("btnIndividualTab")?.addEventListener("click", () => {
        document.getElementById("btnIndividualTab").classList.add("active");
        document.getElementById("btnIndividualTab").setAttribute("aria-selected", "true");
        document.getElementById("btnGroupTab")?.classList.remove("active");
        document.getElementById("btnGroupTab")?.setAttribute("aria-selected", "false");
        document.getElementById("individual-results").classList.add("active-tab");
        document.getElementById("individual-results").style.display = "block";
        const groupResults = document.getElementById("group-results");
        if(groupResults) {
            groupResults.classList.remove("active-tab");
            groupResults.style.display = "none";
        }
    });

    document.getElementById("btnGroupTab")?.addEventListener("click", () => {
        document.getElementById("btnGroupTab").classList.add("active");
        document.getElementById("btnGroupTab").setAttribute("aria-selected", "true");
        document.getElementById("btnIndividualTab")?.classList.remove("active");
        document.getElementById("btnIndividualTab")?.setAttribute("aria-selected", "false");
        document.getElementById("individual-results").classList.remove("active-tab");
        document.getElementById("individual-results").style.display = "none";
        const groupResults = document.getElementById("group-results");
        if(groupResults) {
            groupResults.classList.add("active-tab");
            groupResults.style.display = "block";
        }
        loadGroupReport();
    });

    // Click/touch listener on the stimulus display box to capture responses on screen
    document.getElementById("stimulusDisplayBox")?.addEventListener("pointerdown", (e) => {
        if (!state.currentRunningTest) return;
        const test = state.currentRunningTest;
        if (!test.trialActive && !test.waitingForStimulus) return;
        if (test.testType.includes('choice')) return; // Choice tests require specific button clicks

        // Find the target key configured for this test
        const testTypeCamelCase = test.testType.replace(/-([a-z])/g, (g) => g[1].toUpperCase());
        const testConfig = state.settings.stimuli[testTypeCamelCase];
        if (testConfig && testConfig.targets && testConfig.targets[0]) {
            e.preventDefault();
            const targetKey = testConfig.targets[0].key || 'Space';
            test.handleResponse(targetKey, describePointer(e));
        }
    });
}

function prepareClinicalNotesForPrint() {
    const text = document.getElementById("rptClinicalNotes").value;
    document.getElementById("rptPrintNotesDisplay").innerText = text || "لا توجد ملاحظات عيادية مسجلة لهذه الجلسة.";
}

// ===========================================================================
// SESSION / TEST QUEUE MANAGEMENT
// ===========================================================================
function startNextTestFromQueue() {
    if (state.testQueue.length === 0) return;
    const nextType = state.testQueue.shift();
    startTestEngine(nextType);
}


function populateSettingsForms() {
    const general = state.settings.general;
    const values = {
        cfgTrialsCount: general.trialsCount,
        cfgPracticeTrialsCount: general.practiceTrialsCount,
        cfgMinLatency: general.minLatency,
        cfgMaxLatency: general.maxLatency,
        cfgStimulusDuration: general.stimulusDuration,
        cfgInterStimulus: general.interStimulus,
        cfgMaxResponseTime: general.maxResponseTime
    };
    Object.entries(values).forEach(([id, value]) => {
        const element = document.getElementById(id);
        if (element && value !== undefined && value !== null) element.value = value;
    });

    const checks = {
        cfgPracticeEnabled: general.practiceEnabled,
        cfgPracticeOpenEnded: general.practiceOpenEnded,
        cfgPracticeFeedback: general.practiceFeedback,
        cfgTestFeedback: general.testFeedback,
        cfgRandomOrder: general.randomOrder
    };
    Object.entries(checks).forEach(([id, checked]) => {
        const element = document.getElementById(id);
        if (element) element.checked = Boolean(checked);
    });

    const instructionFields = {
        insVisualSimple: 'visual-simple',
        insVisualDiscriminative: 'visual-discriminative',
        insVisualChoice: 'visual-choice',
        insAuditorySimple: 'auditory-simple',
        insAuditoryDiscriminative: 'auditory-discriminative',
        insAuditoryChoice: 'auditory-choice'
    };
    Object.entries(instructionFields).forEach(([id, key]) => {
        const element = document.getElementById(id);
        if (element) element.value = (state.settings.instructions[key] || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
    });

    syncPracticeSettingsUI();
}

function syncPracticeSettingsUI() {
    const enabled = document.getElementById('cfgPracticeEnabled')?.checked ?? false;
    const openEnded = document.getElementById('cfgPracticeOpenEnded')?.checked ?? false;
    const countInput = document.getElementById('cfgPracticeTrialsCount');
    const openEndedInput = document.getElementById('cfgPracticeOpenEnded');
    const feedbackInput = document.getElementById('cfgPracticeFeedback');
    if (countInput) countInput.disabled = !enabled || openEnded;
    if (openEndedInput) openEndedInput.disabled = !enabled;
    if (feedbackInput) feedbackInput.disabled = !enabled;
}

// Settings Forms Controllers
function initSettingsForms() {
    populateSettingsForms();
    if (document.body.dataset.settingsHandlersInitialized === 'true') {
        renderSettingsStimuli();
        return;
    }
    document.body.dataset.settingsHandlersInitialized = 'true';

    document.getElementById('cfgPracticeEnabled')?.addEventListener('change', syncPracticeSettingsUI);
    document.getElementById('cfgPracticeOpenEnded')?.addEventListener('change', syncPracticeSettingsUI);
    // Tabs switcher in Settings View
    const tabs = document.querySelectorAll(".settings-tab-btn");
    tabs.forEach(tab => {
        tab.addEventListener("click", () => {
            tabs.forEach(t => t.classList.remove("active"));
            tab.classList.add("active");
            
            const targetTab = tab.getAttribute("data-tab");
            document.querySelectorAll(".settings-tab-content").forEach(content => {
                content.classList.remove("active");
            });
            document.getElementById(targetTab)?.classList.add("active");
        });
    });

    // Save General Settings
    document.getElementById("saveGeneralSettingsBtn")?.addEventListener("click", () => {
        state.settings.general.trialsCount = Math.max(1, Math.min(200, parseInt(document.getElementById("cfgTrialsCount")?.value) || 20));
        state.settings.general.practiceEnabled = document.getElementById("cfgPracticeEnabled")?.checked || false;
        state.settings.general.practiceTrialsCount = Math.max(0, Math.min(100, parseInt(document.getElementById("cfgPracticeTrialsCount")?.value) || 0));
        state.settings.general.practiceOpenEnded = document.getElementById("cfgPracticeOpenEnded")?.checked || false;
        state.settings.general.practiceFeedback = document.getElementById("cfgPracticeFeedback")?.checked || false;
        state.settings.general.testFeedback = document.getElementById("cfgTestFeedback")?.checked || false;
        state.settings.general.minLatency = parseFloat(document.getElementById("cfgMinLatency")?.value) || 0.5;
        state.settings.general.maxLatency = parseFloat(document.getElementById("cfgMaxLatency")?.value) || 5.0;
        state.settings.general.stimulusDuration = parseFloat(document.getElementById("cfgStimulusDuration")?.value) || 1.0;
        state.settings.general.interStimulus = parseFloat(document.getElementById("cfgInterStimulus")?.value) || 1.0;
        state.settings.general.maxResponseTime = parseFloat(document.getElementById("cfgMaxResponseTime")?.value) || 3.0;
        state.settings.general.randomOrder = document.getElementById("cfgRandomOrder")?.checked || false;

        if (state.settings.general.maxLatency < state.settings.general.minLatency) {
            state.settings.general.maxLatency = state.settings.general.minLatency;
        }

        touchSettings();
        saveData();
        populateSettingsForms();
        alert("تم حفظ الإعدادات العامة بنجاح!");
    });

    // Reset General Settings
    document.getElementById("resetGeneralSettingsBtn")?.addEventListener("click", () => {
        state.settings.general = { ...DEFAULT_GENERAL_SETTINGS };
        touchSettings();
        populateSettingsForms();
        alert("تمت استعادة الإعدادات الافتراضية. لا تنس الضغط على حفظ.");
    });

    // Save Instructions Settings
    document.getElementById("saveInstructionsSettingsBtn")?.addEventListener("click", () => {
        state.settings.instructions['visual-simple'] = document.getElementById("insVisualSimple")?.value || "";
        state.settings.instructions['visual-discriminative'] = document.getElementById("insVisualDiscriminative")?.value || "";
        state.settings.instructions['visual-choice'] = document.getElementById("insVisualChoice")?.value || "";
        state.settings.instructions['auditory-simple'] = document.getElementById("insAuditorySimple")?.value || "";
        state.settings.instructions['auditory-discriminative'] = document.getElementById("insAuditoryDiscriminative")?.value || "";
        state.settings.instructions['auditory-choice'] = document.getElementById("insAuditoryChoice")?.value || "";
        touchSettings();
        saveData();
        alert("تم حفظ إعدادات التعليمات بنجاح!");
    });

    // Reset Instructions Settings
    document.getElementById("resetInstructionsSettingsBtn")?.addEventListener("click", () => {
        if (!confirm('هل تريد استعادة تعليمات الاختبارات الافتراضية؟')) return;
        state.settings.instructions = deepClone(DEFAULT_INSTRUCTIONS);
        touchSettings();
        populateSettingsForms();
        saveData();
        alert('تمت استعادة تعليمات الاختبارات الافتراضية.');
    });

    // Save Stimuli Settings
    document.getElementById("saveStimuliSettingsBtn")?.addEventListener("click", () => {
        touchSettings();
        saveData();
        alert("تم حفظ إعدادات المثيرات بنجاح!");
    });

    // Reset Stimuli Settings
    document.getElementById("resetStimuliSettingsBtn")?.addEventListener("click", () => {
        if (confirm("هل أنت متأكد من رغبتك في استعادة إعدادات المثيرات الافتراضية؟")) {
            Object.values(state.settings.stimuli || {}).forEach(configuration => {
                [...(configuration.targets || []), ...(configuration.distractors || [])]
                    .forEach(stimulus => deleteStoredStimulus(stimulus.val));
            });
            state.settings.stimuli = JSON.parse(JSON.stringify(DEFAULT_STIMULI));
            touchSettings();
            saveData();
            renderSettingsStimuli();
            alert("تمت استعادة إعدادات المثيرات الافتراضية بنجاح!");
        }
    });

    // Dropdown change listener
    document.getElementById("cfgStimuliTestType")?.addEventListener("change", () => {
        renderSettingsStimuli();
    });

    // Add Target button listener
    document.getElementById("addTargetStimulusBtn")?.addEventListener("click", () => {
        const testType = document.getElementById("cfgStimuliTestType").value;
        const isVisual = testType.toLowerCase().includes("visual");
        const isChoice = testType.toLowerCase().includes("choice");
        if (!isChoice) return;
        if (state.settings.stimuli[testType].targets.length >= MAX_CHOICE_TARGETS) return;
        const usedKeys = new Set(state.settings.stimuli[testType].targets.map(target => target.key));
        const nextKey = VALID_KEYS.find(item => !usedKeys.has(item.key))?.key || 'Space';
        const keyLabel = ({ ArrowUp: '↑', ArrowDown: '↓', ArrowRight: '→', ArrowLeft: '←' })[nextKey] || nextKey.replace('Key', '');

        if (isVisual) {
            state.settings.stimuli[testType].targets.push({
                id: `target_${Date.now()}`,
                type: 'color',
                val: '#2ed573',
                label: 'مستهدف جديد',
                shape: 'circle',
                key: nextKey,
                keyLabel
            });
        } else {
            state.settings.stimuli[testType].targets.push({
                id: `target_${Date.now()}`,
                type: 'sound',
                val: 'buzzer',
                label: 'مستهدف جديد',
                key: nextKey,
                keyLabel
            });
        }
        renderSettingsStimuli();
    });

    // Add Distractor button listener
    document.getElementById("addDistractorStimulusBtn")?.addEventListener("click", () => {
        const testType = document.getElementById("cfgStimuliTestType").value;
        const isVisual = testType.toLowerCase().includes("visual");
        const isChoice = testType.toLowerCase().includes("choice");

        if (isVisual) {
            state.settings.stimuli[testType].distractors.push({
                id: `distractor_${Date.now()}`,
                type: 'color',
                val: '#ff4757',
                label: 'مشتت جديد',
                shape: 'circle',
                ...(isChoice ? { key: 'ignore', keyLabel: 'تجاهل' } : {})
            });
        } else {
            state.settings.stimuli[testType].distractors.push({
                id: `distractor_${Date.now()}`,
                type: 'sound',
                val: 'bell',
                label: 'مشتت جديد',
                ...(isChoice ? { key: 'ignore', keyLabel: 'تجاهل' } : {})
            });
        }
        renderSettingsStimuli();
    });

    // Render Stimuli Lists
    renderSettingsStimuli();
}

const DEFAULT_STIMULI = {
    visualSimple: {
        targets: [{ id: 'green', type: 'color', val: '#2ed573', label: 'أخضر', shape: 'circle', key: 'Space', keyLabel: 'Space' }],
        distractors: []
    },
    visualDiscriminative: {
        targets: [{ id: 'green', type: 'color', val: '#2ed573', label: 'أخضر', shape: 'circle', key: 'Space', keyLabel: 'Space' }],
        distractors: [
            { id: 'red', type: 'color', val: '#ff4757', label: 'أحمر', shape: 'circle', key: 'ignore', keyLabel: 'تجاهل' },
            { id: 'blue', type: 'color', val: '#1e90ff', label: 'أزرق', shape: 'circle', key: 'ignore', keyLabel: 'تجاهل' },
            { id: 'yellow', type: 'color', val: '#ffd700', label: 'أصفر', shape: 'circle', key: 'ignore', keyLabel: 'تجاهل' }
        ]
    },
    visualChoice: {
        targets: [
            { id: 'green', type: 'color', val: '#2ed573', label: 'أخضر', shape: 'circle', key: 'ArrowUp', keyLabel: '↑' },
            { id: 'blue', type: 'color', val: '#1e90ff', label: 'أزرق', shape: 'circle', key: 'ArrowDown', keyLabel: '↓' },
            { id: 'yellow', type: 'color', val: '#ffd700', label: 'أصفر', shape: 'circle', key: 'ArrowRight', keyLabel: '→' }
        ],
        distractors: []
    },
    auditorySimple: {
        targets: [{ id: 'buzzer', type: 'sound', val: 'buzzer', label: 'صفارة', key: 'Space', keyLabel: 'Space' }],
        distractors: []
    },
    auditoryDiscriminative: {
        targets: [{ id: 'buzzer', type: 'sound', val: 'buzzer', label: 'صفارة', key: 'Space', keyLabel: 'Space' }],
        distractors: [
            { id: 'bell', type: 'sound', val: 'bell', label: 'جرس', key: 'ignore', keyLabel: 'تجاهل' },
            { id: 'explosion', type: 'sound', val: 'explosion', label: 'انفجار', key: 'ignore', keyLabel: 'تجاهل' }
        ]
    },
    auditoryChoice: {
        targets: [
            { id: 'buzzer', type: 'sound', val: 'buzzer', label: 'صفارة', key: 'KeyA', keyLabel: 'A' },
            { id: 'bell', type: 'sound', val: 'bell', label: 'جرس', key: 'KeyB', keyLabel: 'B' },
            { id: 'alert', type: 'sound', val: 'alert', label: 'تنبيه', key: 'KeyC', keyLabel: 'C' }
        ],
        distractors: []
    }
};

function renderSettingsStimuli() {
    const testType = document.getElementById("cfgStimuliTestType").value;
    const testConfig = state.settings.stimuli[testType];
    if (!testConfig) return;

    const isVisual = testType.toLowerCase().includes("visual");
    const isChoice = testType.toLowerCase().includes("choice");

    // 1. Render Targets
    const targetContainer = document.getElementById("targetStimuliList");
    targetContainer.innerHTML = "";
    testConfig.targets.forEach((stim, idx) => {
        const card = createStimulusEditCard(stim, 'target', idx, isVisual, isChoice, testType);
        targetContainer.appendChild(card);
    });

    // 2. Render Distractors
    const distractorContainer = document.getElementById("distractorStimuliList");
    distractorContainer.innerHTML = "";
    
    const hasDistractors = testType.includes("Discriminative");
    const distractorBox = document.getElementById('distractorStimuliBox');
    if (distractorBox) distractorBox.style.display = hasDistractors ? '' : 'none';
    
    if (hasDistractors) {
        testConfig.distractors.forEach((stim, idx) => {
            const card = createStimulusEditCard(stim, 'distractor', idx, isVisual, isChoice, testType);
            distractorContainer.appendChild(card);
        });
        document.getElementById("addDistractorStimulusBtn").style.display = "block";
    } else {
        distractorContainer.innerHTML = `<div style="color: var(--text-muted); font-size: 13px; font-weight: 500;">هذا الاختبار لا يحتوي على مثيرات مشتتة.</div>`;
        document.getElementById("addDistractorStimulusBtn").style.display = "none";
    }

    document.getElementById("addTargetStimulusBtn").style.display = isChoice && testConfig.targets.length < MAX_CHOICE_TARGETS ? "inline-flex" : "none";

    // 3. Render Mapping Table
    renderSettingsStimuliMappingOnly();
}

function renderSettingsStimuliMappingOnly() {
    const mapTableBody = document.getElementById("stimuliMappingTableBody");
    if (!mapTableBody) return;
    mapTableBody.innerHTML = "";
    
    const testType = document.getElementById("cfgStimuliTestType").value;
    const testConfig = state.settings.stimuli[testType];
    if (!testConfig) return;

    const isVisual = testType.toLowerCase().includes("visual");
    const hasDistractors = testType.includes("Discriminative");

    testConfig.targets.forEach((stim) => {
        renderMappingRow(mapTableBody, stim, isVisual, "مستهدف");
    });
    
    if (hasDistractors) {
        testConfig.distractors.forEach((stim) => {
            renderMappingRow(mapTableBody, stim, isVisual, "مشتت");
        });
    }
}

function renderMappingRow(parent, stim, isVisual, categoryLabel) {
    const tr = document.createElement("tr");

    const nameCol = document.createElement("td");
    const preview = document.createElement(isVisual && stim.type === 'image' ? 'img' : 'span');
    preview.className = 'mapping-stimulus-preview';
    if (!isVisual) preview.textContent = '🔊';
    else if (stim.type === 'color') preview.style.backgroundColor = /^#[0-9a-f]{3,8}$/i.test(stim.val || '') ? stim.val : '#cccccc';
    else {
        preview.src = stim.val || '';
        preview.alt = '';
    }
    const label = document.createTextNode(` ${stim.label || stim.id || ''}`);
    nameCol.append(preview, label);
    
    const typeCol = document.createElement("td");
    if (isVisual) {
        typeCol.innerText = stim.type === 'color' ? "لون وشكل" : "صورة مرفوعة";
    } else {
        typeCol.innerText = stim.type === 'custom_sound' ? "صوت مخصص مرفوع" : "صوت افتراضي";
    }
    
    const keyCol = document.createElement("td");
    if (stim.key) {
        keyCol.innerText = stim.key === 'ignore' ? "تجاهل" : `${translateKeys(stim.key)} (${stim.keyLabel})`;
    } else {
        keyCol.innerText = "زر المسافة";
    }
    
    const catCol = document.createElement("td");
    catCol.innerText = categoryLabel;
    
    tr.appendChild(nameCol);
    tr.appendChild(typeCol);
    tr.appendChild(keyCol);
    tr.appendChild(catCol);
    
    parent.appendChild(tr);
}

const VALID_KEYS = [
    { key: 'Space', label: 'زر المسافة (Space)' },
    { key: 'Enter', label: 'زر الإدخال (Enter)' },
    { key: 'ArrowUp', label: 'سهم أعلى (↑)' },
    { key: 'ArrowDown', label: 'سهم أسفل (↓)' },
    { key: 'ArrowRight', label: 'سهم يمين (→)' },
    { key: 'ArrowLeft', label: 'سهم يسار (←)' },
    { key: 'KeyA', label: 'حرف A (ش)' },
    { key: 'KeyB', label: 'حرف B (لا)' },
    { key: 'KeyC', label: 'حرف C (ؤ)' },
    { key: 'KeyD', label: 'حرف D (ي)' },
    { key: 'KeyE', label: 'حرف E (ث)' },
    { key: 'KeyF', label: 'حرف F (ب)' },
    { key: 'KeyW', label: 'حرف W (ص)' },
    { key: 'KeyS', label: 'حرف S (س)' }
];

function createStimulusEditCard(stim, category, idx, isVisual, isChoice, testType) {
    const card = document.createElement("div");
    card.className = "stim-edit-card";

    // Header
    const header = document.createElement("div");
    header.className = "stim-edit-card-header";
    
    const title = document.createElement("span");
    title.className = "stim-edit-card-title";
    const numberLabel = category === 'target' ? 'مستهدف' : 'مشتت';
    title.innerText = `${numberLabel} (${idx + 1})`;
    header.appendChild(title);

    // Key badge if choice test
    if (isChoice && stim.key && stim.key !== 'ignore') {
        const badge = document.createElement("span");
        badge.className = "stim-key-badge";
        badge.innerText = `مفتاح الاستجابة: ${translateKeys(stim.key)}`;
        header.appendChild(badge);
    } else if (isChoice && stim.key === 'ignore') {
        const badge = document.createElement("span");
        badge.className = "stim-key-badge";
        badge.style.backgroundColor = "rgba(214, 48, 49, 0.1)";
        badge.style.color = "var(--color-red)";
        badge.innerText = "مفتاح الاستجابة: تجاهل";
        header.appendChild(badge);
    }

    // Choice-test targets are flexible; keep at least one target.
    const canRemoveTarget = category === 'target' && isChoice && state.settings.stimuli[testType].targets.length > 1;
    if (category === 'distractor' || canRemoveTarget) {
        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "stim-remove-card-btn";
        removeBtn.innerHTML = `❌ حذف`;
        removeBtn.addEventListener("click", () => {
            const collection = category === 'target' ? 'targets' : 'distractors';
            deleteStoredStimulus(state.settings.stimuli[testType][collection][idx]?.val);
            state.settings.stimuli[testType][collection].splice(idx, 1);
            renderSettingsStimuli();
        });
        header.appendChild(removeBtn);
    }

    card.appendChild(header);

    // Preview and Content container
    const body = document.createElement("div");
    body.className = "stim-preview-container";

    // Preview Box
    const previewBox = document.createElement("div");
    previewBox.className = `stim-preview-box ${isVisual ? (stim.shape || 'circle') : ''}`;
    if (isVisual) {
        if (stim.type === 'color') {
            previewBox.style.backgroundColor = stim.val;
            previewBox.style.backgroundImage = 'none';
        } else {
            previewBox.style.backgroundImage = `url(${stim.val})`;
            previewBox.style.backgroundColor = 'transparent';
        }
    } else {
        previewBox.innerText = "🔊";
        previewBox.style.cursor = "pointer";
        previewBox.title = "اضغط لتجربة الصوت";
        previewBox.addEventListener("click", () => {
            window.appAudio.playSoundByName(stim.val);
        });
    }
    body.appendChild(previewBox);

    // Controls container
    const controls = document.createElement("div");
    controls.style.flex = "1";
    controls.style.display = "flex";
    controls.style.flexDirection = "column";
    controls.style.gap = "8px";

    // Label Input
    const labelGroup = document.createElement("div");
    labelGroup.className = "form-group";
    labelGroup.style.gap = "4px";
    const labelLabel = document.createElement("label");
    labelLabel.innerText = "تسمية المثير (للتقرير):";
    labelLabel.style.fontSize = "11px";
    const labelInput = document.createElement("input");
    labelInput.type = "text";
    labelInput.value = stim.label || "";
    labelInput.style.padding = "6px 10px";
    labelInput.style.fontSize = "12px";
    labelInput.placeholder = "مثال: دائرة خضراء، صوت عصفور...";
    labelInput.addEventListener("input", () => {
        stim.label = labelInput.value.trim();
        renderSettingsStimuliMappingOnly();
    });
    labelGroup.appendChild(labelLabel);
    labelGroup.appendChild(labelInput);
    controls.appendChild(labelGroup);

    // Key Selection Dropdown (Only for target stimuli)
    if (category === 'target') {
        const keyGroup = document.createElement("div");
        keyGroup.className = "form-group";
        keyGroup.style.gap = "4px";
        
        const keyLabelElement = document.createElement("label");
        keyLabelElement.innerText = "زر الاستجابة المطلوب:";
        keyLabelElement.style.fontSize = "11px";
        
        const keySelect = document.createElement("select");
        keySelect.style.padding = "6px 10px";
        keySelect.style.fontSize = "12px";
        keySelect.style.border = "1px solid var(--border-color)";
        keySelect.style.borderRadius = "var(--radius-sm)";
        keySelect.style.backgroundColor = "var(--bg-input)";
        keySelect.style.color = "var(--text-main)";
        keySelect.style.fontFamily = "var(--font-primary)";
        
        VALID_KEYS.forEach(k => {
            const opt = document.createElement("option");
            opt.value = k.key;
            opt.innerText = k.label;
            keySelect.appendChild(opt);
        });
        
        keySelect.value = stim.key || 'Space';
        keySelect.addEventListener("change", () => {
            stim.key = keySelect.value;
            const symbols = {
                'Space': 'Space', 'Enter': 'Enter',
                'ArrowUp': '↑', 'ArrowDown': '↓', 'ArrowRight': '→', 'ArrowLeft': '←'
            };
            stim.keyLabel = symbols[stim.key] || stim.key.replace('Key', '');
            renderSettingsStimuli();
        });
        
        keyGroup.appendChild(keyLabelElement);
        keyGroup.appendChild(keySelect);
        controls.appendChild(keyGroup);
    }

    if (isVisual) {
        // Visual controls (Type toggle: Color vs Image)
        const toggleWrapper = document.createElement("div");
        toggleWrapper.className = "stim-type-toggle";

        const colorTypeBtn = document.createElement("button");
        colorTypeBtn.type = "button";
        colorTypeBtn.className = `stim-type-btn ${stim.type === 'color' ? 'active' : ''}`;
        colorTypeBtn.innerText = "لون وشكل";
        
        const imageTypeBtn = document.createElement("button");
        imageTypeBtn.type = "button";
        imageTypeBtn.className = `stim-type-btn ${stim.type === 'image' ? 'active' : ''}`;
        imageTypeBtn.innerText = "صورة مخصصة";

        toggleWrapper.appendChild(colorTypeBtn);
        toggleWrapper.appendChild(imageTypeBtn);
        controls.appendChild(toggleWrapper);

        // Sub-controls area
        const subControls = document.createElement("div");
        subControls.className = "stim-controls-grid";

        function renderSubControls() {
            subControls.innerHTML = "";
            if (stim.type === 'color') {
                // Color Picker
                const colorCol = document.createElement("div");
                colorCol.className = "form-group";
                colorCol.style.gap = "4px";
                const cLabel = document.createElement("label");
                cLabel.innerText = "اختر اللون:";
                cLabel.style.fontSize = "11px";
                const cInput = document.createElement("input");
                cInput.type = "color";
                cInput.value = stim.val.startsWith("#") ? stim.val : "#2ed573";
                cInput.style.padding = "2px";
                cInput.style.height = "34px";
                cInput.addEventListener("input", () => {
                    stim.val = cInput.value;
                    previewBox.style.backgroundColor = stim.val;
                    renderSettingsStimuliMappingOnly();
                });
                colorCol.appendChild(cLabel);
                colorCol.appendChild(cInput);

                // Shape Dropdown
                const shapeCol = document.createElement("div");
                shapeCol.className = "form-group";
                shapeCol.style.gap = "4px";
                const sLabel = document.createElement("label");
                sLabel.innerText = "الشكل:";
                sLabel.style.fontSize = "11px";
                const sSelect = document.createElement("select");
                sSelect.style.padding = "6px 10px";
                sSelect.style.fontSize = "12px";
                sSelect.innerHTML = `
                    <option value="circle">دائرة 🟢</option>
                    <option value="rectangle">مستطيل ⬜</option>
                    <option value="triangle">مثلث 🔺</option>
                `;
                sSelect.value = stim.shape || "circle";
                sSelect.addEventListener("change", () => {
                    stim.shape = sSelect.value;
                    previewBox.className = `stim-preview-box ${stim.shape}`;
                });
                shapeCol.appendChild(sLabel);
                shapeCol.appendChild(sSelect);

                subControls.appendChild(colorCol);
                subControls.appendChild(shapeCol);
            } else {
                // Image File Input
                const fileCol = document.createElement("div");
                fileCol.className = "form-group";
                fileCol.style.gridColumn = "span 2";
                fileCol.style.gap = "4px";
                
                const fLabel = document.createElement("label");
                fLabel.innerText = "رفع صورة من الجهاز:";
                fLabel.style.fontSize = "11px";
                
                const fileWrapper = document.createElement("div");
                fileWrapper.className = "file-upload-wrapper";
                
                const uploadBtn = document.createElement("div");
                uploadBtn.className = "file-upload-btn";
                uploadBtn.innerHTML = `📁 اختر صورة...`;
                
                const fInput = document.createElement("input");
                fInput.type = "file";
                fInput.accept = "image/*";
                
                fInput.addEventListener("change", (e) => {
                    const file = e.target.files[0];
                    if (file) {
                        uploadBtn.innerHTML = `⏳ جاري الرفع...`;
                        const reader = new FileReader();
                        reader.onload = function(evt) {
                            compressImage(evt.target.result, 1200, 1200, 0.82, async function(compressed) {
                                try {
                                    const previousValue = stim.val;
                                    const storedValue = await storeStimulusData(compressed, file, 'images');
                                    stim.val = storedValue;
                                    if (previousValue && previousValue !== storedValue) deleteStoredStimulus(previousValue);
                                    previewBox.style.backgroundImage = `url(${storedValue})`;
                                    previewBox.style.backgroundColor = 'transparent';
                                    uploadBtn.textContent = '✓ تم رفع الصورة';
                                    renderSettingsStimuliMappingOnly();
                                    touchSettings();
                                    saveData();
                                } catch (error) {
                                    console.error('Image upload failed:', error);
                                    uploadBtn.textContent = 'تعذر رفع الصورة — حاول مرة أخرى';
                                    showDataStatus('تعذر حفظ الصورة. تأكد من الاتصال وحجم الملف.', 'error');
                                }
                            });
                        };
                        reader.readAsDataURL(file);
                    }
                });

                fileWrapper.appendChild(uploadBtn);
                fileWrapper.appendChild(fInput);
                fileCol.appendChild(fLabel);
                fileCol.appendChild(fileWrapper);
                subControls.appendChild(fileCol);
            }
        }

        colorTypeBtn.addEventListener("click", () => {
            if (stim.type === 'color') return;
            deleteStoredStimulus(stim.val);
            stim.type = 'color';
            stim.val = "#2ed573";
            stim.shape = "circle";
            colorTypeBtn.classList.add("active");
            imageTypeBtn.classList.remove("active");
            previewBox.style.backgroundImage = "none";
            previewBox.style.backgroundColor = stim.val;
            previewBox.className = "stim-preview-box circle";
            renderSubControls();
            renderSettingsStimuliMappingOnly();
        });

        imageTypeBtn.addEventListener("click", () => {
            if (stim.type === 'image') return;
            stim.type = 'image';
            stim.val = "";
            imageTypeBtn.classList.add("active");
            colorTypeBtn.classList.remove("active");
            previewBox.style.backgroundColor = "transparent";
            previewBox.style.backgroundImage = "none";
            renderSubControls();
            renderSettingsStimuliMappingOnly();
        });

        renderSubControls();
        controls.appendChild(subControls);
    } else {
        // Auditory Type toggle (Preset vs Custom Sound)
        const toggleWrapper = document.createElement("div");
        toggleWrapper.className = "stim-type-toggle";

        const presetTypeBtn = document.createElement("button");
        presetTypeBtn.type = "button";
        presetTypeBtn.className = `stim-type-btn ${stim.type !== 'custom_sound' ? 'active' : ''}`;
        presetTypeBtn.innerText = "صوت افتراضي";
        
        const customTypeBtn = document.createElement("button");
        customTypeBtn.type = "button";
        customTypeBtn.className = `stim-type-btn ${stim.type === 'custom_sound' ? 'active' : ''}`;
        customTypeBtn.innerText = "صوت مخصص";

        toggleWrapper.appendChild(presetTypeBtn);
        toggleWrapper.appendChild(customTypeBtn);
        controls.appendChild(toggleWrapper);

        // Sub-controls area
        const subControls = document.createElement("div");
        subControls.style.width = "100%";

        function renderAuditorySubControls() {
            subControls.innerHTML = "";
            if (stim.type !== 'custom_sound') {
                // Dropdown sound select
                const soundCol = document.createElement("div");
                soundCol.className = "form-group";
                soundCol.style.gap = "4px";
                const sLabel = document.createElement("label");
                sLabel.innerText = "اختر الصوت الافتراضي:";
                sLabel.style.fontSize = "11px";
                const sSelect = document.createElement("select");
                sSelect.style.padding = "6px 10px";
                sSelect.style.fontSize = "12px";
                sSelect.style.border = "1px solid var(--border-color)";
                sSelect.style.borderRadius = "var(--radius-sm)";
                sSelect.style.backgroundColor = "var(--bg-input)";
                sSelect.style.color = "var(--text-main)";
                sSelect.style.fontFamily = "var(--font-primary)";
                sSelect.innerHTML = `
                    <optgroup label="أصوات عامة">
                        <option value="buzzer">صفارة 📢</option>
                        <option value="bell">جرس 🔔</option>
                        <option value="alert">منبّه ⏰</option>
                    </optgroup>
                    <optgroup label="الحيوانات">
                        <option value="dog">كلب 🐕</option>
                        <option value="cat">قطة 🐈</option>
                        <option value="bird">طائر 🐦</option>
                        <option value="horse">حصان 🐎</option>
                        <option value="cow">بقرة 🐄</option>
                    </optgroup>
                    <optgroup label="المواصلات">
                        <option value="car_horn">بوق سيارة 🚗</option>
                        <option value="car_engine">محرك سيارة ⚙️</option>
                        <option value="train">قطار 🚆</option>
                        <option value="airplane">طائرة ✈️</option>
                        <option value="motorcycle">دراجة نارية 🏍️</option>
                    </optgroup>
                `;
                sSelect.value = (stim.val && !stim.val.startsWith("data:")) ? stim.val : "buzzer";
                sSelect.addEventListener("change", () => {
                    stim.val = sSelect.value;
                    renderSettingsStimuliMappingOnly();
                });
                soundCol.appendChild(sLabel);
                soundCol.appendChild(sSelect);
                subControls.appendChild(soundCol);
            } else {
                // Audio Upload button
                const fileCol = document.createElement("div");
                fileCol.className = "form-group";
                fileCol.style.gap = "4px";
                
                const fLabel = document.createElement("label");
                fLabel.innerText = "رفع ملف صوتي من الجهاز (أقل من 500KB):";
                fLabel.style.fontSize = "11px";
                
                const fileWrapper = document.createElement("div");
                fileWrapper.className = "file-upload-wrapper";
                
                const uploadBtn = document.createElement("div");
                uploadBtn.className = "file-upload-btn";
                uploadBtn.innerHTML = (stim.val && stim.val.startsWith("data:")) ? `✓ تم رفع صوت مخصص` : `📁 اختر ملفاً صوتياً...`;
                
                const fInput = document.createElement("input");
                fInput.type = "file";
                fInput.accept = "audio/*";
                
                fInput.addEventListener("change", async (e) => {
                    const file = e.target.files[0];
                    if (file) {
                        if (file.size > 5 * 1024 * 1024) {
                            alert("حجم الملف الصوتي يجب ألا يتجاوز 5 ميجابايت.");
                            return;
                        }
                        uploadBtn.textContent = '⏳ جاري الرفع...';
                        try {
                            const previousValue = stim.val;
                            stim.val = await storeStimulusFile(file, 'audio');
                            if (previousValue && previousValue !== stim.val) deleteStoredStimulus(previousValue);
                            uploadBtn.textContent = `✓ تم الرفع (${(file.size/1024).toFixed(0)} KB)`;
                            renderSettingsStimuliMappingOnly();
                            touchSettings();
                            saveData();
                        } catch (error) {
                            console.error('Audio upload failed:', error);
                            uploadBtn.textContent = 'تعذر رفع الصوت — حاول مرة أخرى';
                            showDataStatus('تعذر حفظ الملف الصوتي. تأكد من الاتصال وحجم الملف.', 'error');
                        }
                    }
                });

                fileWrapper.appendChild(uploadBtn);
                fileWrapper.appendChild(fInput);
                fileCol.appendChild(fLabel);
                fileCol.appendChild(fileWrapper);
                subControls.appendChild(fileCol);
            }
        }

        presetTypeBtn.addEventListener("click", () => {
            if (stim.type !== 'custom_sound') return;
            deleteStoredStimulus(stim.val);
            stim.type = 'sound';
            stim.val = "buzzer";
            presetTypeBtn.classList.add("active");
            customTypeBtn.classList.remove("active");
            renderAuditorySubControls();
            renderSettingsStimuliMappingOnly();
        });

        customTypeBtn.addEventListener("click", () => {
            if (stim.type === 'custom_sound') return;
            stim.type = 'custom_sound';
            stim.val = "";
            customTypeBtn.classList.add("active");
            presetTypeBtn.classList.remove("active");
            renderAuditorySubControls();
            renderSettingsStimuliMappingOnly();
        });

        renderAuditorySubControls();
        controls.appendChild(subControls);
    }

    body.appendChild(controls);
    card.appendChild(body);

    return card;
}

function compressImage(base64Str, maxWidth, maxHeight, quality, callback) {
    const img = new Image();
    img.src = base64Str;
    img.onload = function() {
        let width = img.width;
        let height = img.height;
        if (width > height) {
            if (width > maxWidth) {
                height = Math.round((height * maxWidth) / width);
                width = maxWidth;
            }
        } else {
            if (height > maxHeight) {
                width = Math.round((width * maxHeight) / height);
                height = maxHeight;
            }
        }
        
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        
        const compressed = canvas.toDataURL("image/jpeg", quality);
        callback(compressed);
    };
    img.onerror = function() {
        callback(base64Str);
    };
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('File read failed'));
        reader.readAsDataURL(file);
    });
}

async function uploadBlobToFirebase(blob, fileName, folder) {
    await firebaseReady;
    if (!storage || !firebaseUser) return null;
    const extension = String(fileName || '').split('.').pop()?.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
    const objectName = `${makeEntityId('stimulus')}.${extension}`;
    const reference = storage.ref(`app/stimuli/${folder}/${objectName}`);
    const snapshot = await reference.put(blob, { contentType: blob.type || 'application/octet-stream' });
    return snapshot.ref.getDownloadURL();
}

async function deleteStoredStimulus(value) {
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return;
    await firebaseReady;
    if (!storage || !firebaseUser) return;
    try {
        const reference = storage.refFromURL(value);
        const allowedPrefix = 'app/stimuli/';
        if (!reference.fullPath.startsWith(allowedPrefix)) return;
        await reference.delete();
    } catch (error) {
        if (error?.code !== 'storage/object-not-found') {
            console.warn('Could not delete stored stimulus:', error);
        }
    }
}

async function storeStimulusData(dataUrl, originalFile, folder) {
    if (storage && firebaseUser) {
        const blob = await fetch(dataUrl).then(response => response.blob());
        const remoteUrl = await uploadBlobToFirebase(blob, originalFile?.name, folder);
        if (remoteUrl) return remoteUrl;
    }
    return dataUrl;
}

async function storeStimulusFile(file, folder) {
    await firebaseReady;
    const remoteUrl = await uploadBlobToFirebase(file, file.name, folder);
    if (remoteUrl) return remoteUrl;
    if (file.size > 768 * 1024) throw new Error('Local fallback file is too large');
    return readFileAsDataUrl(file);
}

async function migrateEmbeddedStimuliToStorage() {
    if (!storage || !firebaseUser) return;
    const configurations = Object.values(state.settings.stimuli || {});
    for (const configuration of configurations) {
        for (const stimulus of [...(configuration.targets || []), ...(configuration.distractors || [])]) {
            if (typeof stimulus.val !== 'string' || !stimulus.val.startsWith('data:')) continue;
            try {
                const blob = await fetch(stimulus.val).then(response => response.blob());
                const folder = blob.type.startsWith('audio/') ? 'audio' : 'images';
                const extension = blob.type.split('/')[1]?.split('+')[0] || 'bin';
                const remoteUrl = await uploadBlobToFirebase(blob, `legacy.${extension}`, folder);
                if (remoteUrl) stimulus.val = remoteUrl;
            } catch (error) {
                console.warn('Could not migrate embedded stimulus:', error);
            }
        }
    }
}

// Dashboard Charts Renderers (Chart.js)
function renderDashboardCharts() {
    if (state.sessions.length === 0 || typeof Chart === 'undefined') return;

    const isDark = document.body.classList.contains("dark-mode");
    const gridColor = isDark ? '#2b334a' : '#dfe4ea';
    const textColor = isDark ? '#f1f2f6' : '#2d3436';

    // 1. Overall Accuracy Donut
    const correctSum = state.sessions.reduce((acc, s) => acc + s.correctCount, 0);
    const wrongSum = state.sessions.reduce((acc, s) => acc + s.wrongCount, 0);
    const missSum = state.sessions.reduce((acc, s) => acc + s.missCount, 0);

    const dbAccCtx = document.getElementById("dashboardAccuracyChart");
    if (dbAccCtx) {
        if (dbAccuracyChart) dbAccuracyChart.destroy();
        dbAccuracyChart = new Chart(dbAccCtx, {
            type: 'doughnut',
            data: {
                labels: ['صحيح', 'خاطئ', 'استجابة فائتة'],
                datasets: [{
                    data: [correctSum, wrongSum, missSum],
                    backgroundColor: ['#00b894', '#ff7675', '#b2bec3'],
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: { color: textColor, font: { family: 'Cairo' } }
                    }
                },
                cutout: '70%'
            }
        });
    }

    // 2. Trend Line Chart
    // Sort runs chronologically
    const sorted = [...state.sessions].sort((a,b) => new Date(a.date) - new Date(b.date));
    const dates = sorted.map(s => new Date(s.date).toLocaleDateString('ar-EG', {month:'short', day:'numeric'}));
    const reactionTimes = sorted.map(s => s.avgReactionTime);

    const dbTrendCtx = document.getElementById("dashboardReactionTrendChart");
    if (dbTrendCtx) {
        if (dbReactionTrendChart) dbReactionTrendChart.destroy();
        dbReactionTrendChart = new Chart(dbTrendCtx, {
            type: 'line',
            data: {
                labels: dates,
                datasets: [{
                    label: 'متوسط زمن الاستجابة (ثانية)',
                    data: reactionTimes,
                    borderColor: '#6c5ce7',
                    backgroundColor: 'rgba(108, 92, 231, 0.1)',
                    borderWidth: 2,
                    tension: 0.3,
                    fill: true
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    x: {
                        grid: { color: gridColor },
                        ticks: { color: textColor, font: { family: 'Cairo', size: 9 } }
                    },
                    y: {
                        grid: { color: gridColor },
                        ticks: { color: textColor, font: { family: 'Cairo', size: 9 } }
                    }
                }
            }
        });
    }
}

function getSessionsForStudent(student) {
    if (!student) return [];
    return state.sessions
        .filter(session => session.studentId === student.id || (!session.studentId && session.studentName === student.name))
        .sort((a, b) => new Date(b.date) - new Date(a.date));
}

function populateSessionOptions(studentId, preferredSessionId = '') {
    const select = document.getElementById("historySessionSelect");
    if (!select) return;
    select.innerHTML = '<option value="">-- اختر جلسة لعرض تقريرها --</option>';
    select.disabled = !studentId;

    const student = state.students.find(item => item.id === studentId);
    const sessions = getSessionsForStudent(student);
    sessions.forEach(session => {
        const testName = getTestArabicName(session.testType);
        const formattedDate = new Date(session.date).toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' });
        const option = document.createElement("option");
        option.value = session.id;
        option.innerText = `${testName} — ${formattedDate}`;
        select.appendChild(option);
    });

    const sessionToSelect = preferredSessionId || (state.activeSession && sessions.some(item => item.id === state.activeSession.id)
        ? state.activeSession.id
        : '');
    select.value = sessionToSelect;
}

function renderStudentTestsOverview(studentId) {
    const container = document.getElementById("studentTestsOverview");
    const grid = document.getElementById("studentTestResultsGrid");
    if (!container || !grid) return;

    const student = state.students.find(item => item.id === studentId);
    if (!student) {
        container.style.display = "none";
        grid.innerHTML = "";
        return;
    }

    const sessions = getSessionsForStudent(student);
    container.style.display = "block";
    document.getElementById("studentOverviewTitle").innerText = `جميع نتائج: ${student.name}`;
    const metaParts = [
        student.age ? `${student.age} سنة` : null,
        student.gender || null,
        student.category || null,
        student.iq ? `IQ: ${student.iq}` : null
    ].filter(Boolean);
    document.getElementById("studentOverviewMeta").innerText = metaParts.length
        ? metaParts.join(' • ')
        : 'لم تُسجل بيانات وصفية لهذه الحالة.';
    document.getElementById("studentOverviewSessionCount").innerText = `${sessions.length} جلسة`;

    grid.innerHTML = "";
    TEST_TYPES.forEach(testType => {
        const testSessions = sessions.filter(session => session.testType === testType);
        const latest = testSessions[0];
        const card = document.createElement("article");
        card.className = `student-test-result-card ${testType.startsWith('auditory') ? 'auditory' : 'visual'}`;

        if (!latest) {
            card.innerHTML = `
                <h5>${escapeHtml(getTestArabicName(testType))}</h5>
                <div class="student-test-card-empty">لم يتم تطبيق هذا الاختبار بعد.</div>
            `;
        } else {
            const accuracy = Number.isFinite(Number(latest.accuracy))
                ? Number(latest.accuracy)
                : (latest.trialsCount ? (latest.correctCount / latest.trialsCount) * 100 : 0);
            const formattedDate = new Date(latest.date).toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' });
            const stdDevText = latest.stdDevReactionTime === null || latest.stdDevReactionTime === undefined
                ? '—'
                : `${Number(latest.stdDevReactionTime).toFixed(2)} ث`;
            card.innerHTML = `
                <h5>${escapeHtml(getTestArabicName(testType))}</h5>
                <div class="student-test-card-metrics">
                    <span>عدد التطبيقات<strong>${testSessions.length}</strong></span>
                    <span>الدقة<strong>${accuracy.toFixed(1)}%</strong></span>
                    <span>متوسط الزمن<strong>${Number(latest.avgReactionTime || 0).toFixed(2)} ث</strong></span>
                    <span>الانحراف المعياري<strong>${stdDevText}</strong></span>
                </div>
                <div class="student-test-card-footer">
                    <span>الأحدث: ${escapeHtml(formattedDate)}</span>
                    <button class="secondary-btn small-btn open-student-session-btn" data-session-id="${escapeHtml(latest.id)}">فتح التقرير</button>
                </div>
            `;
        }
        grid.appendChild(card);
    });
}

// Populate student and session selectors in the individual results view.
function populateSessionsList() {
    const studentSelect = document.getElementById("historyStudentSelect");
    if (!studentSelect) return;
    const previousStudentId = studentSelect.value;
    studentSelect.innerHTML = '<option value="">-- اختر طالبًا لعرض جميع نتائجه --</option>';

    const sortedStudents = [...state.students].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ar'));
    sortedStudents.forEach(student => {
        const option = document.createElement('option');
        option.value = student.id;
        option.innerText = student.name || 'حالة غير مسماة';
        studentSelect.appendChild(option);
    });

    let selectedStudentId = previousStudentId;
    if (state.activeSession?.studentId) selectedStudentId = state.activeSession.studentId;
    if (!selectedStudentId || !state.students.some(student => student.id === selectedStudentId)) {
        selectedStudentId = state.activeStudentId && state.students.some(student => student.id === state.activeStudentId)
            ? state.activeStudentId
            : '';
    }

    studentSelect.value = selectedStudentId;
    const deleteStudentButton = document.getElementById('deleteStudentBtn');
    if (deleteStudentButton) deleteStudentButton.style.display = selectedStudentId ? 'inline-flex' : 'none';
    renderStudentTestsOverview(selectedStudentId);
    populateSessionOptions(selectedStudentId, state.activeSession?.id || '');

    if (state.activeSession && selectedStudentId && state.activeSession.studentId === selectedStudentId) {
        loadSessionReport(state.activeSession);
    }
}

function getTrialResultMeta(result) {
    const map = {
        correct: { label: 'استجابة صحيحة', className: 'correct' },
        'correct-rejection': { label: 'تجاهل صحيح', className: 'correct' },
        wrong: { label: 'اختيار خاطئ', className: 'wrong' },
        miss: { label: 'استجابة فائتة', className: 'miss' },
        'false-alarm': { label: 'ضغط خاطئ على مشتت', className: 'wrong' },
        early: { label: 'استجابة مبكرة', className: 'wrong' }
    };
    return map[result] || { label: result || 'غير محدد', className: 'miss' };
}

function loadSessionReport(session) {
    session = normalizeSession(session);
    const sessionIndexInState = state.sessions.findIndex(item => item.id === session.id);
    if (sessionIndexInState !== -1) state.sessions[sessionIndexInState] = session;
    state.activeSession = session;

    const noPlaceholder = document.getElementById("noSessionPlaceholder");
    if (noPlaceholder) noPlaceholder.style.display = "none";
    
    const reportArea = document.getElementById("reportDocumentArea");
    if (reportArea) reportArea.style.display = "block";

    const deleteBtn = document.getElementById("deleteSessionBtn");
    if (deleteBtn) deleteBtn.style.display = "inline-flex";

    // Student info - prefer the snapshot saved with the session, then the current record.
    const studentRecord = state.students.find(student => student.id === session.studentId) || {};
    const studentName = session.studentName || studentRecord.name || '--';
    const studentAge  = session.studentAge ?? studentRecord.age ?? '--';
    const studentGender = session.studentGender || studentRecord.gender || '--';
    const studentCategory = session.studentCategory || studentRecord.category || '--';
    const studentIQ = session.studentIQ ?? studentRecord.iq ?? '--';

    const elName = document.getElementById("lblReportStudentName");
    const elAge  = document.getElementById("lblReportStudentAge");
    const elGender = document.getElementById("lblReportStudentGender");
    const elCategory = document.getElementById("lblReportStudentCategory");
    const elIQ = document.getElementById("lblReportStudentIQ");
    const elSessionNum = document.getElementById("lblReportSessionNum");

    if (elName)   elName.innerText   = studentName;
    if (elAge)    elAge.innerText    = studentAge !== '--' ? `${studentAge} سنة` : '--';
    if (elGender) elGender.innerText = studentGender;
    if (elCategory) elCategory.innerText = studentCategory;
    if (elIQ) elIQ.innerText = studentIQ;
    if (elSessionNum) {
        // Count how many sessions this student has (current session's position)
        const studentSessions = state.sessions.filter(s => session.studentId ? s.studentId === session.studentId : s.studentName === session.studentName);
        const sessionIndex = studentSessions.findIndex(s => s.id === session.id) + 1;
        elSessionNum.innerText = sessionIndex || '--';
    }

    // Test info
    const elTestType = document.getElementById("lblReportTestType");
    const elDateTime = document.getElementById("lblReportDateTime");
    const elDuration = document.getElementById("lblReportDuration");
    const elInputMethod = document.getElementById('lblReportInputMethod');

    if (elTestType)    elTestType.innerText    = getTestArabicName(session.testType);
    if (elDateTime)    elDateTime.innerText    = new Date(session.date).toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' });
    if (elDuration)    elDuration.innerText    = session.duration || "00:00";
    if (elInputMethod) elInputMethod.innerText = translateInputMethod(session.inputMethod);

    // Specialist info in print header
    const spec = session.specialist || state.sessionSpecialist;
    const elSpecialist = document.getElementById("lblPrintSpecialist");
    const elCenter     = document.getElementById("lblPrintCenter");
    if (spec) {
        if (elSpecialist) elSpecialist.innerText = `المختص: ${spec.name || ''}${spec.title ? ' - ' + spec.title : ''}`;
        if (elCenter)     elCenter.innerText     = `المؤسسة: ${spec.center || ''}`;
    } else {
        if (elSpecialist) elSpecialist.innerText = 'المختص: --';
        if (elCenter)     elCenter.innerText     = 'المؤسسة: --';
    }

    // Metrics bindings (with null checks)
    const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.innerText = val; };

    const pct = value => session.trialsCount > 0 ? (Number(value || 0) / session.trialsCount) * 100 : 0;
    setEl("lblValTotalTrials", session.trialsCount);
    setEl("lblValPracticeTrials", session.practiceTrialsCount || 0);
    setEl("lblValAvgTime", milliseconds(session.avgReactionTime));
    setEl("lblValMedianTime", milliseconds(session.medianReactionTime));
    setEl("lblValStdDev", session.stdDevReactionTime === null ? "—" : milliseconds(session.stdDevReactionTime));
    setEl("lblValFastest", milliseconds(session.fastestTime));
    setEl("lblValSlowest", milliseconds(session.slowestTime));
    setEl("lblValCorrect", session.correctCount);
    setEl("lblValCorrectPct", `(${pct(session.correctCount).toFixed(1)}%)`);
    setEl("lblValCorrectRejection", session.correctRejectionCount || 0);
    setEl("lblValWrong", session.wrongChoiceCount || 0);
    setEl("lblValWrongPct", `(${pct(session.wrongChoiceCount).toFixed(1)}%)`);
    setEl("lblValMiss", session.missCount || 0);
    setEl("lblValMissPct", `(${pct(session.missCount).toFixed(1)}%)`);
    setEl("lblValFalseAlarm", session.falseAlarmCount || 0);
    setEl("lblValFalseAlarmPct", `(${pct(session.falseAlarmCount).toFixed(1)}%)`);
    setEl("lblValEarly", session.earlyCount || 0);
    setEl("lblValEarlyPct", `(${pct(session.earlyCount).toFixed(1)}%)`);
    setEl("lblValAccuracy", `${Number(session.accuracy || 0).toFixed(1)}%`);
    setEl("lblValErrorRate", `${Number(session.errorRate || 0).toFixed(1)}%`);

    // Clinical Notes
    const notesEl = document.getElementById("rptClinicalNotes");
    if (notesEl) notesEl.value = session.clinicalNotes || "";

    // Print date
    setEl("lblPrintDate", new Date().toLocaleDateString('ar-EG'));

    // Populate Detailed trials table
    const tableBody = document.getElementById("reportDetailsTableBody");
    if (tableBody) {
        tableBody.innerHTML = "";
        (session.trials || []).forEach(trial => {
            const tr = document.createElement("tr");
            const formattedTime = trial.timestamp ? new Date(trial.timestamp).toLocaleTimeString('ar-EG') : '--';
            const resultMeta = getTrialResultMeta(trial.result);

            tr.innerHTML = `
                <td>${trial.index}</td>
                <td><strong>${escapeHtml(trial.stimulusName || '--')}</strong></td>
                <td>${escapeHtml(translateKeys(trial.requiredKey))}</td>
                <td>${trial.actualKey ? escapeHtml(translateKeys(trial.actualKey)) : '---'}</td>
                <td><span class="badge-status ${resultMeta.className}">${resultMeta.label}</span></td>
                <td>${trial.latency !== null && trial.latency !== undefined && Number.isFinite(Number(trial.latency)) ? milliseconds(trial.latency) : '---'}</td>
                <td>${formattedTime}</td>
            `;
            tableBody.appendChild(tr);
        });
    }

    const practiceSection = document.getElementById('practiceDetailsSection');
    const practiceTableBody = document.getElementById('practiceDetailsTableBody');
    if (practiceSection && practiceTableBody) {
        const practiceTrials = session.practiceTrials || [];
        practiceSection.style.display = practiceTrials.length ? 'block' : 'none';
        practiceTableBody.innerHTML = '';
        practiceTrials.forEach(trial => {
            const row = document.createElement('tr');
            const resultMeta = getTrialResultMeta(trial.result);
            row.innerHTML = `
                <td>${trial.index}</td>
                <td><strong>${escapeHtml(trial.stimulusName || '--')}</strong></td>
                <td>${escapeHtml(translateKeys(trial.requiredKey))}</td>
                <td>${trial.actualKey ? escapeHtml(translateKeys(trial.actualKey)) : '---'}</td>
                <td><span class="badge-status ${resultMeta.className}">${resultMeta.label}</span></td>
                <td>${trial.latency !== null && trial.latency !== undefined && Number.isFinite(Number(trial.latency)) ? milliseconds(trial.latency) : '---'}</td>
            `;
            practiceTableBody.appendChild(row);
        });
    }

    renderReportCharts(session);
}

function translateKeys(key) {
    const keys = {
        'Space': 'زر المسافة (Space)',
        'ArrowUp': '↑ سهم أعلى',
        'ArrowDown': '↓ سهم أسفل',
        'ArrowRight': '→ سهم يمين',
        'ArrowLeft': '← سهم يسار',
        'KeyA': 'A',
        'KeyB': 'B',
        'KeyC': 'C',
        'KeyD': 'D'
    };
    return keys[key] || key;
}

// Render report Charts
function renderReportCharts(session) {
    if (typeof Chart === 'undefined') return;
    const isDark = document.body.classList.contains("dark-mode");
    const gridColor = isDark ? '#2b334a' : '#dfe4ea';
    const textColor = isDark ? '#f1f2f6' : '#2d3436';

    // 1. Accuracy Donut
    const rptAccCtx = document.getElementById("rptAccuracyDonut");
    if (rptAccuracyDonutChart) rptAccuracyDonutChart.destroy();
    rptAccuracyDonutChart = new Chart(rptAccCtx, {
        type: 'doughnut',
        data: {
            labels: ['صحيح', 'اختيار خاطئ', 'استجابة فائتة', 'ضغط خاطئ على مشتت', 'مبكرة'],
            datasets: [{
                data: [session.correctCount, session.wrongChoiceCount || 0, session.missCount, session.falseAlarmCount || 0, session.earlyCount || 0],
                backgroundColor: ['#00b894', '#1e90ff', '#9b59b6', '#e74c3c', '#e17055'],
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { color: textColor, font: { family: 'Cairo', size: 10 } }
                }
            },
            cutout: '70%'
        }
    });

    // 2. Timeline Line chart
    const timelineCtx = document.getElementById("rptResponseTimeline");
    const trialIndices = session.trials.map(t => t.index);
    const trialLatencies = session.trials.map(t => t.latency === null || t.latency === undefined ? null : milliseconds(t.latency));

    if (rptResponseTimelineChart) rptResponseTimelineChart.destroy();
    rptResponseTimelineChart = new Chart(timelineCtx, {
        type: 'line',
        data: {
            labels: trialIndices,
            datasets: [{
                label: 'زمن الاستجابة (مللي ثانية)',
                data: trialLatencies,
                borderColor: '#6c5ce7',
                backgroundColor: 'rgba(108, 92, 231, 0.08)',
                borderWidth: 2,
                spanGaps: true, // skip Miss values visually
                tension: 0.2,
                fill: true
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: {
                    grid: { color: gridColor },
                    ticks: { color: textColor, font: { family: 'Cairo', size: 9 } }
                },
                y: {
                    grid: { color: gridColor },
                    ticks: { color: textColor, font: { family: 'Cairo', size: 9 } }
                }
            }
        }
    });

    // 3. Stimulus Bar Chart (Choice tests comparison)
    const barContainer = document.getElementById("rptStimulusBarContainer");
    
    if (session.testType === 'visual-choice' || session.testType === 'auditory-choice') {
        barContainer.style.display = "block";
        const barCtx = document.getElementById("rptStimulusBar");

        // Group latencies by stimulus
        const stimulusGroups = {};
        session.trials.forEach(trial => {
            if (trial.result === 'correct' && trial.latency !== null) {
                if (!stimulusGroups[trial.stimulusName]) stimulusGroups[trial.stimulusName] = [];
                stimulusGroups[trial.stimulusName].push(trial.latency);
            }
        });

        const labels = Object.keys(stimulusGroups);
        const averages = labels.map(label => {
            const sum = stimulusGroups[label].reduce((a,b) => a + b, 0);
            return milliseconds(sum / stimulusGroups[label].length);
        });

        if (rptStimulusBarChart) rptStimulusBarChart.destroy();
        rptStimulusBarChart = new Chart(barCtx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: 'متوسط زمن الرجع (مللي ثانية)',
                    data: averages,
                    backgroundColor: ['#2ed573', '#1e90ff', '#ffd700', '#ffa500', '#ff4757'].slice(0, labels.length),
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: {
                        grid: { color: gridColor },
                        ticks: { color: textColor, font: { family: 'Cairo', size: 9 } }
                    },
                    y: {
                        grid: { color: gridColor },
                        ticks: { color: textColor, font: { family: 'Cairo', size: 9 } }
                    }
                }
            }
        });
    } else {
        barContainer.style.display = "none";
    }
}

function xmlEscape(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function excelCellXml(value, isHeader = false) {
    const style = isHeader ? ' ss:StyleID="Header"' : '';
    if (typeof value === 'number' && Number.isFinite(value)) {
        return `<Cell${style}><Data ss:Type="Number">${value}</Data></Cell>`;
    }
    return `<Cell${style}><Data ss:Type="String">${xmlEscape(value ?? '')}</Data></Cell>`;
}

function worksheetXml(name, rows) {
    const safeName = String(name).replace(/[\\/\?\*\[\]:]/g, ' ').slice(0, 31) || 'Sheet';
    const body = rows.map((row, rowIndex) => `<Row>${row.map(value => excelCellXml(value, rowIndex === 0)).join('')}</Row>`).join('');
    return `<Worksheet ss:Name="${xmlEscape(safeName)}"><Table>${body}</Table><WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><Selected/><ProtectObjects>False</ProtectObjects><ProtectScenarios>False</ProtectScenarios></WorksheetOptions></Worksheet>`;
}

function downloadExcelWorkbook(fileBaseName, sheets) {
    const safeFileName = String(fileBaseName || 'نتائج_المقياس').replace(/[\\/:*?"<>|\s]+/g, '_');
    if (typeof XLSX !== 'undefined') {
        const workbook = XLSX.utils.book_new();
        workbook.Workbook = { Views: [{ RTL: true }] };
        sheets.forEach(sheetDefinition => {
            const sheet = XLSX.utils.aoa_to_sheet(sheetDefinition.rows, { cellDates: true });
            const columnCount = Math.max(...sheetDefinition.rows.map(row => row.length), 1);
            sheet['!cols'] = Array.from({ length: columnCount }, (_, columnIndex) => ({
                wch: Math.min(42, Math.max(12, ...sheetDefinition.rows.map(row => String(row[columnIndex] ?? '').length + 2)))
            }));
            if (sheetDefinition.layout?.kind === 'wide-reaction') {
                configureWideReactionWorksheet(sheet, sheetDefinition, XLSX);
            }
            const safeSheetName = String(sheetDefinition.name).replace(/[\\/\?\*\[\]:]/g, ' ').slice(0, 31) || 'Sheet';
            XLSX.utils.book_append_sheet(workbook, sheet, safeSheetName);
        });
        XLSX.writeFile(workbook, `${safeFileName}_${new Date().toISOString().slice(0, 10)}.xlsx`, { compression: true, cellDates: true, cellStyles: true });
        return;
    }

    // Offline fallback for environments where the XLSX library could not load.
    const workbook = `<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Styles>
  <Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Vertical="Center"/><Font ss:FontName="Arial" ss:Size="11"/></Style>
  <Style ss:ID="Header"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Arial" ss:Size="11" ss:Bold="1"/><Interior ss:Color="#D9EAF7" ss:Pattern="Solid"/></Style>
 </Styles>
 ${sheets.map(sheet => worksheetXml(sheet.name, sheet.rows)).join('')}
</Workbook>`;
    const blob = new Blob(['\ufeff', workbook], { type: 'application/vnd.ms-excel;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${safeFileName}_${new Date().toISOString().slice(0, 10)}.xls`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
}

function exportSessionsToExcel(sessions, fileBaseName, studentsOverride = null) {
    const normalizedSessions = (sessions || []).map(normalizeSession).sort((a, b) => new Date(a.date) - new Date(b.date));
    if (!normalizedSessions.length) {
        alert('لا توجد جلسات في النطاق المحدد للتصدير.');
        return;
    }
    const relevantIds = new Set(normalizedSessions.map(session => session.studentId).filter(Boolean));
    const students = (studentsOverride || state.students).filter(student => relevantIds.has(student.id));

    const studentRows = [["اسم الطالب", "العمر", "الجنس", "الفئة", "نسبة الذكاء", "تاريخ التسجيل"]];
    students.forEach(student => studentRows.push([
        student.name || 'حالة غير مسماة',
        student.age ?? '',
        student.gender || '',
        student.category || '',
        student.iq ?? '',
        student.createdAt ? new Date(student.createdAt) : ''
    ]));

    const summaryRows = [[
        "رقم الجلسة", "اسم الطالب", "الفئة", "نوع الاختبار", "تاريخ التطبيق",
        "المحاولات الرسمية", "المحاولات التدريبية غير المحتسبة", "الصحيح الكلي", "الاستجابات الصحيحة بضغطة",
        "التجاهل الصحيح", "الاختيار الخاطئ", "الاستجابات الفائتة", "الضغط الخاطئ على المشتت", "الاستجابة المبكرة", "الاستجابة المتأخرة المستبعدة",
        "الدقة %", "نسبة الخطأ %", "متوسط زمن الاستجابة", "وسيط زمن الاستجابة", "الانحراف المعياري", "أسرع استجابة", "أبطأ استجابة",
        "اسم المختص", "المؤسسة", "مدة الجلسة", "طريقة الاستجابة", "الجهاز", "أبعاد الشاشة"
    ]];
    normalizedSessions.forEach(session => summaryRows.push([
        session.id,
        session.studentName || 'حالة غير مسماة',
        session.studentCategory || '',
        getTestArabicName(session.testType),
        new Date(session.date),
        session.trialsCount,
        session.practiceTrialsCount || 0,
        session.correctCount,
        session.responseCorrectCount || 0,
        session.correctRejectionCount || 0,
        session.wrongChoiceCount || 0,
        session.missCount || 0,
        session.falseAlarmCount || 0,
        session.earlyCount || 0,
        session.lateCount || 0,
        Number(session.accuracy.toFixed(2)),
        Number(session.errorRate.toFixed(2)),
        Number(session.avgReactionTime || 0),
        Number(session.medianReactionTime || 0),
        session.stdDevReactionTime === null ? '' : Number(session.stdDevReactionTime),
        Number(session.fastestTime || 0),
        Number(session.slowestTime || 0),
        session.specialist?.name || '',
        session.specialist?.center || '',
        session.duration || '',
        session.inputMethod || '',
        session.deviceInfo?.platform || '',
        session.deviceInfo?.screen || ''
    ]));

    const formalRows = [[
        "رقم الجلسة", "اسم الطالب", "نوع الاختبار", "رقم المحاولة الرسمية", "المثير",
        "الاستجابة المطلوبة", "الاستجابة الفعلية", "النتيجة", "زمن الاستجابة (مللي ثانية)", "حالة الاحتساب", "طريقة الاستجابة", "وقت المحاولة"
    ]];
    const practiceRows = [[
        "رقم الجلسة", "اسم الطالب", "نوع الاختبار", "رقم المحاولة التدريبية", "المثير",
        "الاستجابة المطلوبة", "الاستجابة الفعلية", "النتيجة", "زمن الاستجابة (مللي ثانية)", "طريقة الاستجابة", "وقت المحاولة", "حالة الاحتساب"
    ]];
    normalizedSessions.forEach(session => {
        (session.trials || []).forEach(trial => formalRows.push([
            session.id,
            session.studentName || 'حالة غير مسماة',
            getTestArabicName(session.testType),
            trial.index,
            trial.stimulusName || '',
            translateKeys(trial.requiredKey),
            trial.actualKey ? translateKeys(trial.actualKey) : '',
            getTrialResultMeta(trial.result).label,
            trial.latency === null || trial.latency === undefined ? '' : Math.round(Number(trial.latency) * 1000),
            getTrialCalculationStatus(trial, session),
            trial.inputMethod || session.inputMethod || '',
            trial.timestamp ? new Date(trial.timestamp) : ''
        ]));
        (session.practiceTrials || []).forEach(trial => practiceRows.push([
            session.id,
            session.studentName || 'حالة غير مسماة',
            getTestArabicName(session.testType),
            trial.index,
            trial.stimulusName || '',
            translateKeys(trial.requiredKey),
            trial.actualKey ? translateKeys(trial.actualKey) : '',
            getTrialResultMeta(trial.result).label,
            trial.latency === null || trial.latency === undefined ? '' : Math.round(Number(trial.latency) * 1000),
            trial.inputMethod || session.inputMethod || '',
            trial.timestamp ? new Date(trial.timestamp) : '',
            'تدريب غير محتسب'
        ]));
    });

    const overviewRows = [["اسم الطالب", "نوع الاختبار", "عدد التطبيقات", "تاريخ أحدث تطبيق", "أحدث دقة %", "أحدث متوسط زمن الاستجابة", "أحدث وسيط زمن الاستجابة", "أحدث انحراف معياري"]];
    students.forEach(student => {
        const studentSessions = normalizedSessions.filter(session => session.studentId === student.id || (!session.studentId && session.studentName === student.name));
        TEST_TYPES.forEach(testType => {
            const matches = studentSessions.filter(session => session.testType === testType).sort((a, b) => new Date(b.date) - new Date(a.date));
            const latest = matches[0];
            overviewRows.push([
                student.name || 'حالة غير مسماة',
                getTestArabicName(testType),
                matches.length,
                latest ? new Date(latest.date) : '',
                latest ? Number(latest.accuracy.toFixed(2)) : '',
                latest ? Number(latest.avgReactionTime || 0) : '',
                latest ? Number(latest.medianReactionTime || 0) : '',
                latest && latest.stdDevReactionTime !== null ? Number(latest.stdDevReactionTime) : ''
            ]);
        });
    });

    const visualSheet = buildWideModalitySheet(normalizedSessions, 'visual');
    const auditorySheet = buildWideModalitySheet(normalizedSessions, 'auditory');
    downloadExcelWorkbook(fileBaseName, [
        { name: 'بيانات الحالات', rows: studentRows },
        { name: 'ملخص النتائج', rows: summaryRows },
        { name: 'جميع اختبارات الطالب', rows: overviewRows },
        { name: 'التقرير الجماعي', rows: buildGroupExcelRows(normalizedSessions) },
        { name: 'إجماليات المحاولات', rows: buildGroupTrialsTotalsRows(normalizedSessions) },
        { name: 'تفاصيل التقرير الجماعي', rows: buildGroupTrialDetailsRows(normalizedSessions) },
        visualSheet,
        auditorySheet,
        { name: 'المحاولات الرسمية', rows: formalRows },
        { name: 'التدريب غير المحتسب', rows: practiceRows }
    ]);
}

// ==========================================================================
// GROUP REPORTING ENGINE
// ==========================================================================
let grpAvgRTChartInstance = null;
let grpFastestRTChartInstance = null;
let grpSlowestRTChartInstance = null;


function summarizeSessions(sessions) {
    const normalized = sessions.map(normalizeSession);
    const trials = normalized.reduce((sum, session) => sum + formalTrialCount(session), 0);
    const misses = normalized.reduce((sum, session) => sum + session.missCount, 0);
    const practice = normalized.reduce((sum, session) => sum + (session.practiceTrialsCount || 0), 0);
    const correctRejections = normalized.reduce((sum, session) => sum + session.correctRejectionCount, 0);
    const falseAlarms = normalized.reduce((sum, session) => sum + session.falseAlarmCount, 0);
    const earlyResponses = normalized.reduce((sum, session) => sum + session.earlyCount, 0);
    const lateResponses = normalized.reduce((sum, session) => sum + session.lateCount, 0);
    const fastest = normalized.map(session => Number(session.fastestTime)).filter(value => value > 0);
    const slowest = normalized.map(session => Number(session.slowestTime)).filter(value => value > 0);

    // First average repeated sessions for each student and subtest, then average students.
    const studentTypeGroups = new Map();
    normalized.forEach(session => {
        const studentKey = session.studentId || session.studentCode || `legacy:${session.studentName || session.id}`;
        const groupKey = `${studentKey}::${session.testType || 'unknown'}`;
        if (!studentTypeGroups.has(groupKey)) studentTypeGroups.set(groupKey, { studentKey, sessions: [] });
        studentTypeGroups.get(groupKey).sessions.push(session);
    });
    const students = new Map();
    studentTypeGroups.forEach(group => {
        const typeSummary = {
            mean: mean(group.sessions.map(session => Number(session.avgReactionTime)).filter(value => value > 0)),
            accuracy: mean(group.sessions.map(session => Number(session.accuracy ?? (session.trialsCount ? session.correctCount / session.trialsCount * 100 : 0)))),
            errorRate: mean(group.sessions.map(session => Number(session.errorRate ?? 0))),
            missRate: mean(group.sessions.map(session => session.trialsCount ? session.missCount / session.trialsCount * 100 : 0))
        };
        if (!students.has(group.studentKey)) students.set(group.studentKey, { typeSummaries: [], sessions: [] });
        students.get(group.studentKey).typeSummaries.push(typeSummary);
        students.get(group.studentKey).sessions.push(...group.sessions);
    });
    const participantSummaries = [...students.values()].map(participant => ({
        mean: mean(participant.typeSummaries.map(summary => summary.mean).filter(value => value > 0)),
        accuracy: mean(participant.typeSummaries.map(summary => summary.accuracy)),
        errorRate: mean(participant.typeSummaries.map(summary => summary.errorRate)),
        missRate: mean(participant.typeSummaries.map(summary => summary.missRate)),
        age: participant.sessions.map(session => safeNumber(session.studentAge, null)).find(value => value !== null),
        iq: participant.sessions.map(session => safeNumber(session.studentIQ, null)).find(value => value !== null)
    }));
    const participantMeans = participantSummaries.map(summary => summary.mean).filter(value => value > 0);
    const ages = participantSummaries.map(summary => summary.age).filter(value => value !== null && value !== undefined);
    const iqs = participantSummaries.map(summary => summary.iq).filter(value => value !== null && value !== undefined);
    return {
        students: students.size,
        sessions: normalized.length,
        trials,
        practice,
        mean: mean(participantMeans),
        median: median(participantMeans),
        stdDev: sampleStdDev(participantMeans),
        fastest: fastest.length ? Math.min(...fastest) : 0,
        slowest: slowest.length ? Math.max(...slowest) : 0,
        accuracy: mean(participantSummaries.map(summary => summary.accuracy)),
        errorRate: mean(participantSummaries.map(summary => summary.errorRate)),
        missRate: mean(participantSummaries.map(summary => summary.missRate)),
        avgAge: ages.length ? mean(ages) : null,
        avgIQ: iqs.length ? mean(iqs) : null,
        misses,
        correctRejections,
        falseAlarms,
        earlyResponses,
        lateResponses
    };
}

function getFilteredGroupSessions() {
    const fromValue = document.getElementById('cfgGroupDateFrom')?.value;
    const toValue = document.getElementById('cfgGroupDateTo')?.value;
    const gender = document.getElementById('cfgGroupGender')?.value;
    const ageFrom = safeNumber(document.getElementById('cfgGroupAgeFrom')?.value, null);
    const ageTo = safeNumber(document.getElementById('cfgGroupAgeTo')?.value, null);
    const iqFrom = safeNumber(document.getElementById('cfgGroupIQFrom')?.value, null);
    const iqTo = safeNumber(document.getElementById('cfgGroupIQTo')?.value, null);
    const category = document.getElementById('cfgGroupCategory')?.value || '';
    const testType = document.getElementById('cfgGroupTestType')?.value;
    const from = fromValue ? new Date(`${fromValue}T00:00:00`) : null;
    const to = toValue ? new Date(`${toValue}T23:59:59`) : null;

    return state.sessions.filter(session => {
        const student = state.students.find(item => item.id === session.studentId) || {};
        const date = new Date(session.date);
        const sessionAge = safeNumber(session.studentAge ?? student.age, null);
        const sessionGender = session.studentGender || student.gender || '';
        const sessionIQ = safeNumber(session.studentIQ ?? student.iq, null);
        const sessionCategory = session.studentCategory || student.category || '';
        if (from && date < from) return false;
        if (to && date > to) return false;
        if (gender && sessionGender !== gender) return false;
        if (ageFrom !== null && (sessionAge === null || sessionAge < ageFrom)) return false;
        if (ageTo !== null && (sessionAge === null || sessionAge > ageTo)) return false;
        if (iqFrom !== null && (sessionIQ === null || sessionIQ < iqFrom)) return false;
        if (iqTo !== null && (sessionIQ === null || sessionIQ > iqTo)) return false;
        if (category && sessionCategory !== category) return false;
        if (testType && session.testType !== testType) return false;
        return true;
    }).map(normalizeSession);
}

function buildGroupReportEntries(sessions, testFilter = '') {
    const entries = [{ classification: 'الإجمالي', name: 'جميع النتائج', summary: summarizeSessions(sessions) }];
    const mainGroups = [
        { label: 'بصري', types: TEST_TYPES.filter(type => type.startsWith('visual')) },
        { label: 'سمعي', types: TEST_TYPES.filter(type => type.startsWith('auditory')) }
    ];
    if (!testFilter) {
        mainGroups.forEach(group => {
            entries.push({
                classification: 'نوع رئيسي',
                name: group.label,
                summary: summarizeSessions(sessions.filter(session => group.types.includes(session.testType)))
            });
        });
    }
    TEST_TYPES.filter(type => !testFilter || type === testFilter).forEach(type => {
        entries.push({
            classification: 'نوع فرعي',
            name: getTestArabicName(type),
            summary: summarizeSessions(sessions.filter(session => session.testType === type))
        });
    });
    return entries;
}

function buildGroupExcelRows(sessions, testFilter = '') {
    const rows = [[
        'التصنيف', 'نوع الاختبار', 'المحاولات الرسمية',
        'التدريب غير المحتسب', 'متوسط العمر', 'متوسط نسبة الذكاء',
        'متوسط زمن الاستجابة (مللي ثانية)', 'وسيط زمن الاستجابة (مللي ثانية)', 'الانحراف المعياري (مللي ثانية)',
        'أسرع استجابة (مللي ثانية)', 'أبطأ استجابة (مللي ثانية)', 'الدقة %', 'نسبة الخطأ %',
        'الاستجابات الفائتة %', 'عدد الاستجابات الفائتة', 'التجاهل الصحيح', 'الضغط الخاطئ على المشتت', 'الاستجابات المبكرة', 'الاستجابات المتأخرة المستبعدة'
    ]];
    buildGroupReportEntries(sessions, testFilter).forEach(entry => {
        const summary = entry.summary;
        rows.push([
            entry.classification,
            entry.name,
            summary.trials,
            summary.practice,
            summary.avgAge === null ? '' : Number(summary.avgAge.toFixed(2)),
            summary.avgIQ === null ? '' : Number(summary.avgIQ.toFixed(2)),
            milliseconds(summary.mean),
            milliseconds(summary.median),
            summary.stdDev === null ? '' : milliseconds(summary.stdDev),
            milliseconds(summary.fastest),
            milliseconds(summary.slowest),
            Number(summary.accuracy.toFixed(2)),
            Number(summary.errorRate.toFixed(2)),
            Number(summary.missRate.toFixed(2)),
            summary.misses,
            summary.correctRejections,
            summary.falseAlarms,
            summary.earlyResponses,
            summary.lateResponses
        ]);
    });
    return rows;
}

function formalTrialCount(session) {
    const rawTrials = Array.isArray(session.trials) ? session.trials : [];
    return rawTrials.length || safeNumber(session.trialsCount, 0);
}

function buildGroupTrialsTotalsRows(sessions, testFilter = '') {
    const normalized = sessions.map(normalizeSession);
    const rows = [['النطاق', 'نوع الاختبار', 'مجموع المحاولات الرسمية']];
    TEST_TYPES.filter(type => !testFilter || type === testFilter).forEach(type => {
        rows.push([
            'اختبار منفرد',
            getTestArabicName(type),
            normalized.filter(session => session.testType === type).reduce((sum, session) => sum + formalTrialCount(session), 0)
        ]);
    });
    if (!testFilter) {
        const visualSessions = normalized.filter(session => session.testType?.startsWith('visual'));
        const auditorySessions = normalized.filter(session => session.testType?.startsWith('auditory'));
        rows.push(['الاختبارات البصرية الثلاثة', 'إجمالي البصري', visualSessions.reduce((sum, session) => sum + formalTrialCount(session), 0)]);
        rows.push(['الاختبارات السمعية الثلاثة', 'إجمالي السمعي', auditorySessions.reduce((sum, session) => sum + formalTrialCount(session), 0)]);
        rows.push(['الاختبارات الستة', 'الإجمالي الكلي', normalized.reduce((sum, session) => sum + formalTrialCount(session), 0)]);
    }
    return rows;
}

function buildGroupTrialDetailsRows(sessions) {
    const rows = [[
        'اسم الطالب', 'الفئة', 'القسم', 'نوع الاختبار', 'رقم المحاولة',
        'المثير', 'النتيجة', 'زمن الاستجابة (مللي ثانية)', 'حالة الاحتساب'
    ]];
    sessions.map(normalizeSession).forEach(session => {
        (session.trials || []).forEach(trial => rows.push([
            session.studentName || 'حالة غير مسماة',
            session.studentCategory || 'غير محدد',
            session.testType?.startsWith('visual') ? 'بصري' : 'سمعي',
            getTestArabicName(session.testType),
            trial.index,
            trial.stimulusName || '',
            getTrialResultMeta(trial.result).label,
            trial.latency === null || trial.latency === undefined ? '' : milliseconds(trial.latency),
            getTrialCalculationStatus(trial, session)
        ]));
    });
    return rows;
}

function getExcelColumnName(columnIndex) {
    let name = '';
    let value = columnIndex + 1;
    while (value > 0) {
        const remainder = (value - 1) % 26;
        name = String.fromCharCode(65 + remainder) + name;
        value = Math.floor((value - 1) / 26);
    }
    return name;
}

function buildWideModalitySheet(sessions, modality) {
    const normalized = (sessions || []).map(normalizeSession)
        .filter(session => session.testType?.startsWith(`${modality}-`));
    const testTypes = [`${modality}-simple`, `${modality}-discriminative`, `${modality}-choice`];
    const trialsPerTest = Math.max(20, ...normalized.map(session => formalTrialCount(session)));
    const modalityArabic = modality === 'visual' ? 'البصري' : 'السمعي';
    const typeArabic = modality === 'visual' ? 'البصري' : 'السمعي';
    const statisticLabels = [
        'عدد المحاولات الصحيحة',
        'عدد المحاولات الخاطئة',
        'عدد الاستجابات المبكرة',
        'عدد الاستجابات المتأخرة',
        'عدد الاستجابات الفائتة'
    ];
    const rows = [[], []];

    rows[0].push('بيانات أساسية', '', '', '');
    ['البسيط', 'التمييزي', 'الاختياري'].forEach(level => {
        rows[0].push(`زمن الرجع ${typeArabic} ${level}`, ...Array(trialsPerTest + statisticLabels.length).fill(''));
    });
    rows[0].push('المؤشرات الكلية', '', '');

    rows[1].push('الاسم أو الحالة', 'النوع', 'العمر', 'نسبة الذكاء');
    const totalLabels = [
        `مجموع أزمنة ${typeArabic} البسيط`,
        `مجموع أزمنة ${typeArabic} التمييزي`,
        `مجموع أزمنة ${typeArabic} الاختياري`
    ];
    totalLabels.forEach(totalLabel => {
        for (let index = 1; index <= trialsPerTest; index += 1) rows[1].push(`محاولة رقم ${index}`);
        rows[1].push(...statisticLabels, totalLabel);
    });
    rows[1].push(
        `المجموع الكلي ${modalityArabic}`,
        `المتوسط الكلي ${modalityArabic} للاستجابات الصحيحة`,
        `الانحراف المعياري الكلي ${modalityArabic} للاستجابات الصحيحة`
    );

    const groups = new Map();
    normalized.forEach(session => {
        const key = session.studentId || `legacy-session:${session.id}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(session);
    });

    [...groups.entries()]
        .map(([studentId, studentSessions]) => {
            const student = state.students.find(item => item.id === studentId) || {};
            const firstSession = studentSessions[0] || {};
            return {
                studentId,
                studentSessions,
                name: student.name || firstSession.studentName || 'حالة غير مسماة',
                gender: student.gender || firstSession.studentGender || '',
                age: student.age ?? firstSession.studentAge ?? '',
                iq: student.iq ?? firstSession.studentIQ ?? ''
            };
        })
        .sort((first, second) => first.name.localeCompare(second.name, 'ar'))
        .forEach(group => {
            const latestSessions = testTypes.map(testType => group.studentSessions
                .filter(session => session.testType === testType)
                .sort((first, second) => new Date(second.date) - new Date(first.date))[0] || null);
            const row = [group.name, group.gender, group.age, group.iq];
            const allCorrectTimes = [];
            let modalityTotal = 0;

            latestSessions.forEach(session => {
                const trialValues = Array(trialsPerTest).fill('');
                const counts = { correct: 0, wrong: 0, early: 0, late: 0, miss: 0 };
                let validTotal = 0;
                if (session) {
                    [...(session.trials || [])]
                        .sort((first, second) => safeNumber(first.index, 0) - safeNumber(second.index, 0))
                        .forEach((trial, position) => {
                            const trialNumber = Math.max(1, safeNumber(trial.index, position + 1));
                            const latency = safeNumber(trial.latency, null);
                            if (trialNumber <= trialsPerTest && latency !== null) {
                                trialValues[trialNumber - 1] = milliseconds(latency);
                            }
                            const category = getTrialAnalysisCategory(trial, session);
                            if (Object.prototype.hasOwnProperty.call(counts, category)) counts[category] += 1;
                        });
                    const validCorrectTimes = getCorrectReactionTimes(session).map(time => milliseconds(time));
                    validCorrectTimes.forEach(time => allCorrectTimes.push(time));
                    validTotal = validCorrectTimes.reduce((sum, time) => sum + time, 0);
                }
                modalityTotal += validTotal;
                row.push(
                    ...trialValues,
                    counts.correct,
                    counts.wrong,
                    counts.early,
                    counts.late,
                    counts.miss,
                    validTotal
                );
            });

            row.push(
                modalityTotal,
                allCorrectTimes.length ? Math.round(mean(allCorrectTimes)) : '',
                allCorrectTimes.length >= 2 ? Math.round(sampleStdDev(allCorrectTimes)) : ''
            );
            rows.push(row);
        });

    return {
        name: `زمن الرجع ${modalityArabic}`,
        rows,
        layout: { kind: 'wide-reaction', modality, trialsPerTest, statisticCount: statisticLabels.length }
    };
}

function configureWideReactionWorksheet(sheet, sheetDefinition, xlsxLibrary) {
    const trialsPerTest = sheetDefinition.layout.trialsPerTest;
    const statisticCount = sheetDefinition.layout.statisticCount || 0;
    const blockWidth = trialsPerTest + statisticCount + 1;
    const basicEnd = 3;
    const firstBlockStart = 4;
    const firstBlockEnd = firstBlockStart + blockWidth - 1;
    const secondBlockStart = firstBlockEnd + 1;
    const secondBlockEnd = secondBlockStart + blockWidth - 1;
    const thirdBlockStart = secondBlockEnd + 1;
    const thirdBlockEnd = thirdBlockStart + blockWidth - 1;
    const overallStart = thirdBlockEnd + 1;
    const lastColumn = overallStart + 2;
    const encodeRange = (startColumn, endColumn) => xlsxLibrary.utils.encode_range({ s: { r: 0, c: startColumn }, e: { r: 0, c: endColumn } });
    sheet['!merges'] = [
        encodeRange(0, basicEnd),
        encodeRange(firstBlockStart, firstBlockEnd),
        encodeRange(secondBlockStart, secondBlockEnd),
        encodeRange(thirdBlockStart, thirdBlockEnd),
        encodeRange(overallStart, lastColumn)
    ].map(range => xlsxLibrary.utils.decode_range(range));
    sheet['!views'] = [{ RTL: true }];
    sheet['!autofilter'] = { ref: `A2:${getExcelColumnName(lastColumn)}${sheetDefinition.rows.length}` };
    sheet['!rows'] = [{ hpt: 28 }, { hpt: 54 }];
    const blockStarts = [firstBlockStart, secondBlockStart, thirdBlockStart];
    const summaryColumns = new Set();
    blockStarts.forEach(blockStart => {
        for (let offset = trialsPerTest; offset < blockWidth; offset += 1) summaryColumns.add(blockStart + offset);
    });
    sheet['!cols'] = Array.from({ length: lastColumn + 1 }, (_, columnIndex) => ({
        wch: columnIndex === 0
            ? 24
            : columnIndex <= 3
                ? 12
                : columnIndex >= overallStart || summaryColumns.has(columnIndex)
                    ? 19
                    : 13
    }));

    const border = {
        top: { style: 'thin', color: { rgb: 'FF808080' } },
        bottom: { style: 'thin', color: { rgb: 'FF808080' } },
        left: { style: 'thin', color: { rgb: 'FF808080' } },
        right: { style: 'thin', color: { rgb: 'FF808080' } }
    };
    const fills = [
        { start: 0, end: basicEnd, color: 'FFD9E1F2' },
        { start: firstBlockStart, end: firstBlockEnd, color: 'FFFFF200' },
        { start: secondBlockStart, end: secondBlockEnd, color: 'FFA9D18E' },
        { start: thirdBlockStart, end: thirdBlockEnd, color: 'FFF4B183' },
        { start: overallStart, end: lastColumn, color: 'FFF4CCCC' }
    ];
    const fillForColumn = columnIndex => fills.find(range => columnIndex >= range.start && columnIndex <= range.end)?.color || 'FFFFFFFF';

    for (let rowIndex = 0; rowIndex < sheetDefinition.rows.length; rowIndex += 1) {
        for (let columnIndex = 0; columnIndex <= lastColumn; columnIndex += 1) {
            const address = xlsxLibrary.utils.encode_cell({ r: rowIndex, c: columnIndex });
            if (!sheet[address]) sheet[address] = { t: 's', v: '' };
            const isHeader = rowIndex <= 1;
            const isTotalColumn = summaryColumns.has(columnIndex) || columnIndex >= overallStart;
            sheet[address].s = {
                font: { name: 'Arial', sz: isHeader ? 11 : 10, bold: isHeader || isTotalColumn },
                fill: { patternType: 'solid', fgColor: { rgb: isHeader ? fillForColumn(columnIndex) : (isTotalColumn ? 'FFFCE4D6' : 'FFFFFFFF') } },
                alignment: { horizontal: columnIndex === 0 && rowIndex > 1 ? 'right' : 'center', vertical: 'center', wrapText: true },
                border
            };
        }
    }
}

function loadGroupReport() {
    const sessions = getFilteredGroupSessions();
    const overall = summarizeSessions(sessions);
    document.querySelectorAll('.lblGroupPrintDate').forEach(element => {
        element.innerText = new Date().toLocaleDateString('ar-EG');
    });

    const setText = (id, value) => {
        const element = document.getElementById(id);
        if (element) element.innerText = value;
    };
    setText('lblGroupAvgAge', overall.avgAge === null ? '—' : overall.avgAge.toFixed(1));
    setText('lblGroupAvgIQ', overall.avgIQ === null ? '—' : overall.avgIQ.toFixed(1));
    setText('lblGroupTotalTrials', overall.trials);
    setText('lblGroupPracticeTrials', overall.practice);
    setText('lblGroupAvgRT', milliseconds(overall.mean));
    setText('lblGroupMedianRT', milliseconds(overall.median));
    setText('lblGroupStdDev', overall.stdDev === null ? '—' : milliseconds(overall.stdDev));
    setText('lblGroupAvgAccuracy', `${overall.accuracy.toFixed(1)}%`);
    setText('lblGroupErrorPct', `${overall.errorRate.toFixed(1)}%`);
    setText('lblGroupMissPct', `${overall.missRate.toFixed(1)}%`);
    setText('lblGroupCorrectRejections', overall.correctRejections);
    setText('lblGroupFalseAlarms', overall.falseAlarms);
    setText('lblGroupEarlyResponses', overall.earlyResponses);

    const testFilter = document.getElementById('cfgGroupTestType')?.value || '';
    const rows = buildGroupReportEntries(sessions, testFilter).filter(row => row.classification !== 'الإجمالي');

    const tbody = document.getElementById('groupSummaryTableBody');
    if (tbody) {
        tbody.innerHTML = '';
        rows.forEach(row => {
            const summary = row.summary;
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${row.classification}</td>
                <td><strong>${escapeHtml(row.name)}</strong></td>
                <td>${summary.trials}</td>
                <td>${summary.practice}</td>
                <td>${milliseconds(summary.mean)}</td>
                <td>${milliseconds(summary.median)}</td>
                <td>${summary.stdDev === null ? '—' : milliseconds(summary.stdDev)}</td>
                <td>${summary.accuracy.toFixed(1)}%</td>
                <td>${summary.errorRate.toFixed(1)}%</td>
                <td>${summary.missRate.toFixed(1)}%</td>
            `;
            tbody.appendChild(tr);
        });
    }

    const totalsBody = document.getElementById('groupTrialsTotalsBody');
    if (totalsBody) {
        totalsBody.innerHTML = '';
        buildGroupTrialsTotalsRows(sessions, testFilter).slice(1).forEach(row => {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td>${escapeHtml(row[0])}</td><td>${escapeHtml(row[1])}</td><td>${row[2]}</td>`;
            totalsBody.appendChild(tr);
        });
    }

    const detailsBody = document.getElementById('groupTrialDetailsBody');
    if (detailsBody) {
        detailsBody.innerHTML = '';
        buildGroupTrialDetailsRows(sessions).slice(1).forEach(row => {
            const tr = document.createElement('tr');
            tr.innerHTML = row.map((value, index) => `<td>${index === 7 && value === '' ? '—' : escapeHtml(value)}</td>`).join('');
            detailsBody.appendChild(tr);
        });
        if (!detailsBody.children.length) {
            const tr = document.createElement('tr');
            tr.innerHTML = '<td colspan="8">لا توجد محاولات رسمية مطابقة لعوامل التصفية.</td>';
            detailsBody.appendChild(tr);
        }
    }

    const subtestRows = rows.filter(row => row.classification === 'نوع فرعي');
    const labels = subtestRows.map(row => row.name);
    const chartOptions = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
            x: { ticks: { font: { family: 'Cairo', size: 9 } } },
            y: { beginAtZero: true, ticks: { font: { family: 'Cairo', size: 9 } } }
        }
    };
    if (typeof Chart !== 'undefined') {
        if (grpAvgRTChartInstance) grpAvgRTChartInstance.destroy();
        if (grpFastestRTChartInstance) grpFastestRTChartInstance.destroy();
        if (grpSlowestRTChartInstance) grpSlowestRTChartInstance.destroy();
        grpAvgRTChartInstance = new Chart(document.getElementById('grpAvgRTChart'), {
            type: 'bar',
            data: { labels, datasets: [{ data: subtestRows.map(row => milliseconds(row.summary.mean)), backgroundColor: '#6c5ce7', borderRadius: 4 }] },
            options: chartOptions
        });
        grpFastestRTChartInstance = new Chart(document.getElementById('grpFastestRTChart'), {
            type: 'bar',
            data: { labels, datasets: [{ data: subtestRows.map(row => milliseconds(row.summary.fastest)), backgroundColor: '#2ed573', borderRadius: 4 }] },
            options: chartOptions
        });
        grpSlowestRTChartInstance = new Chart(document.getElementById('grpSlowestRTChart'), {
            type: 'bar',
            data: { labels, datasets: [{ data: subtestRows.map(row => milliseconds(row.summary.slowest)), backgroundColor: '#ff4757', borderRadius: 4 }] },
            options: chartOptions
        });
    }
}

// ==========================================================================
// TEST RUNNING ENGINE
// ==========================================================================

class TestEngine {
    constructor(testType) {
        this.testType = testType;
        this.config = { ...DEFAULT_GENERAL_SETTINGS, ...deepClone(state.settings.general) };
        this.student = state.students.find(student => student.id === state.activeStudentId) || state.sessionStudent;
        this.formalTrialsList = this.buildTrialSequence(this.config.trialsCount);
        const practiceSeedCount = this.config.practiceOpenEnded
            ? Math.max(10, this.config.practiceTrialsCount || 0)
            : this.config.practiceTrialsCount;
        this.practiceTrialsList = this.buildTrialSequence(Math.max(0, practiceSeedCount));
        this.currentTrialIndex = 0;
        this.results = [];
        this.practiceResults = [];
        this.mode = 'formal';
        this.startTime = null;
        this.isStopped = false;
        this.trialActive = false;
        this.waitingForStimulus = false;
        this.currentRequiredKey = 'Space';
        this.currentStimulusObject = null;
        this.stimulusOnTime = 0;
        this.countdownTimer = null;
        this.stimulusTimer = null;
        this.trialTimer = null;
        this.feedbackTimer = null;
        this.advanceTimer = null;
        this.audioOnsetTimer = null;
        this.inputMethods = new Set();
        this.deviceInfo = collectDeviceInfo();
        this.assetsReady = Promise.resolve();
    }

    init() {
        this.showOverlay();
        this.showStep('arenaStepInstructions');
        this.setupInstructionsView();
        window.appAudio?.init();
        const stimuli = this.getStimuliConfig();
        const audioReady = window.appAudio?.preloadSounds([
            ...(stimuli.targets || []).map(item => item.val),
            ...(stimuli.distractors || []).map(item => item.val)
        ]) || Promise.resolve();
        const imageReady = Promise.allSettled([...(stimuli.targets || []), ...(stimuli.distractors || [])]
            .filter(item => item.type === 'image' && item.val)
            .map(item => new Promise(resolve => {
                const image = new Image();
                image.onload = () => resolve();
                image.onerror = () => resolve();
                image.src = item.val;
                if (typeof image.decode === 'function') image.decode().then(resolve).catch(() => {});
            })));
        this.assetsReady = Promise.allSettled([audioReady, imageReady]);
    }

    showOverlay() {
        const overlay = document.getElementById('testingOverlay');
        overlay.style.display = 'flex';
        if (overlay.requestFullscreen) overlay.requestFullscreen().catch(() => {});
        else if (overlay.webkitRequestFullscreen) overlay.webkitRequestFullscreen();
    }

    closeOverlay() {
        document.getElementById('testingOverlay').style.display = 'none';
        if (document.fullscreenElement || document.webkitFullscreenElement) {
            if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
            else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
        }
    }

    showStep(stepId) {
        document.querySelectorAll('.arena-step').forEach(step => step.classList.remove('active'));
        document.getElementById(stepId)?.classList.add('active');
    }

    setupInstructionsView() {
        const testName = getTestArabicName(this.testType);
        document.getElementById('arenaTestTitle').innerText = testName;
        const currentTestName = document.getElementById('arenaCurrentTestName');
        if (currentTestName) currentTestName.innerText = `الاختبار ${testName}`;
        document.getElementById('arenaInstructionText').innerHTML = sanitizeInstructionHtml(state.settings.instructions[this.testType] || '');
        const keymapBox = document.getElementById('arenaKeymapPreview');
        keymapBox.innerHTML = '';
        keymapBox.style.display = 'none';
        if (this.testType.includes('choice')) {
            const configKey = this.testType.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
            const targets = state.settings.stimuli[configKey]?.targets || [];
            keymapBox.style.display = 'flex';
            keymapBox.style.gap = '12px';
            keymapBox.style.justifyContent = 'center';
            keymapBox.style.marginTop = '16px';
            targets.forEach(stimulus => {
                const item = document.createElement('div');
                item.style.textAlign = 'center';
                item.style.fontSize = '12px';
                const preview = stimulus.type === 'color'
                    ? `<span class="stimulus-color-dot" style="display:inline-block;width:16px;height:16px;border-radius:50%;background:${escapeHtml(stimulus.val)}"></span>`
                    : '🔊';
                item.innerHTML = `${preview}<div>${escapeHtml(translateKeys(stimulus.key))}</div>`;
                keymapBox.appendChild(item);
            });
        }
    }

    getStimuliConfig() {
        const configKey = this.testType.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
        return state.settings.stimuli[configKey] || { targets: [], distractors: [] };
    }

    buildTrialSequence(total) {
        if (!total) return [];
        const { targets = [], distractors = [] } = this.getStimuliConfig();
        const list = [];
        if (!targets.length) return list;

        if (this.testType.includes('simple')) {
            for (let index = 0; index < total; index++) list.push({ isTarget: true, stim: targets[0] });
        } else if (this.testType.includes('discriminative')) {
            const targetCount = Math.round(total * 0.7);
            const distractorCount = total - targetCount;
            for (let index = 0; index < targetCount; index++) list.push({ isTarget: true, stim: targets[index % targets.length] });
            for (let index = 0; index < distractorCount; index++) {
                const stimulus = distractors.length ? distractors[index % distractors.length] : targets[0];
                list.push({ isTarget: !distractors.length, stim: stimulus });
            }
        } else {
            for (let index = 0; index < total; index++) {
                if (distractors.length && index % 5 === 4) list.push({ isTarget: false, stim: distractors[index % distractors.length] });
                else list.push({ isTarget: true, stim: targets[index % targets.length] });
            }
        }

        if (this.config.randomOrder) {
            for (let index = list.length - 1; index > 0; index--) {
                const randomIndex = Math.floor(Math.random() * (index + 1));
                [list[index], list[randomIndex]] = [list[randomIndex], list[index]];
            }
        }
        return list;
    }

    async startSessionFlow() {
        await window.appAudio?.init();
        await this.assetsReady;
        if (this.isStopped) return;
        const shouldPractice = this.config.practiceEnabled && (this.config.practiceOpenEnded || this.config.practiceTrialsCount > 0);
        if (shouldPractice) this.startPracticeCountdown();
        else this.startFormalCountdown();
    }

    startPracticeCountdown() {
        this.mode = 'practice';
        this.currentTrialIndex = 0;
        this.startCountdown('practice');
    }

    startFormalCountdown() {
        this.mode = 'formal';
        this.currentTrialIndex = 0;
        this.startCountdown('formal');
    }

    startCountdown(mode) {
        this.mode = mode;
        this.showStep('arenaStepCountdown');
        const textElement = document.querySelector('#arenaStepCountdown .countdown-text');
        if (textElement) textElement.innerText = mode === 'practice' ? 'الاستعداد لبدء التدريب غير المحتسب...' : 'الاستعداد لبدء الاختبار الرسمي...';
        let count = 3;
        document.getElementById('countdownNumber').innerText = count;
        clearInterval(this.countdownTimer);
        this.countdownTimer = setInterval(() => {
            count -= 1;
            if (count > 0) document.getElementById('countdownNumber').innerText = count;
            else {
                clearInterval(this.countdownTimer);
                this.startTestingPlay();
            }
        }, 1000);
    }

    startTestingPlay() {
        if (this.mode === 'formal') this.startTime = Date.now();
        this.showStep('arenaStepPlay');
        const openEndedPractice = this.mode === 'practice' && this.config.practiceOpenEnded;
        const total = this.mode === 'practice' ? this.config.practiceTrialsCount : this.config.trialsCount;
        document.getElementById('trialTotalCount').innerText = openEndedPractice ? 'مفتوح' : total;
        const stageLabel = document.getElementById('trialStageLabel');
        stageLabel.innerText = this.mode === 'practice' ? 'محاولة تدريبية غير محسوبة' : 'محاولة رسمية محتسبة';
        stageLabel.classList.toggle('practice', this.mode === 'practice');
        document.getElementById('finishPracticeNowBtn').style.display = this.mode === 'practice' ? 'inline-flex' : 'none';
        this.buildProgressDots(openEndedPractice ? Math.max(10, this.practiceResults.length + 1) : total);
        this.runTrial();
    }

    buildProgressDots(total) {
        const container = document.getElementById('trialProgressDots');
        container.innerHTML = '';
        for (let index = 0; index < total; index++) {
            const dot = document.createElement('span');
            dot.className = 'progress-dot';
            container.appendChild(dot);
        }
    }

    ensureProgressDot(index) {
        const container = document.getElementById('trialProgressDots');
        while (container.children.length <= index) {
            const dot = document.createElement('span');
            dot.className = 'progress-dot';
            container.appendChild(dot);
        }
    }

    currentSequence() {
        return this.mode === 'practice' ? this.practiceTrialsList : this.formalTrialsList;
    }

    runTrial() {
        if (this.isStopped) return;
        const isPractice = this.mode === 'practice';
        if (isPractice && !this.config.practiceOpenEnded && this.currentTrialIndex >= this.config.practiceTrialsCount) {
            this.completePractice();
            return;
        }
        if (!isPractice && this.currentTrialIndex >= this.config.trialsCount) {
            this.endTest();
            return;
        }

        const sequence = this.currentSequence();
        if (!sequence.length) {
            if (isPractice) this.completePractice();
            else this.endTest();
            return;
        }
        const currentTrial = sequence[this.currentTrialIndex % sequence.length];
        this.currentStimulusObject = currentTrial.stim;
        this.currentRequiredKey = currentTrial.isTarget ? (currentTrial.stim.key || 'Space') : (currentTrial.stim.key || 'ignore');
        this.trialActive = false;
        this.waitingForStimulus = true;

        this.ensureProgressDot(this.currentTrialIndex);
        document.querySelectorAll('.progress-dot').forEach((dot, index) => dot.classList.toggle('active', index === this.currentTrialIndex));
        document.getElementById('trialCurrentIndex').innerText = this.currentTrialIndex + 1;
        document.getElementById('trialFeedbackOverlay').style.display = 'none';
        document.getElementById('stimulusPlaceholder').innerHTML = '';
        this.renderOnScreenGuides();

        const minWait = Number(this.config.minLatency) * 1000;
        const maxWait = Math.max(minWait, Number(this.config.maxLatency) * 1000);
        const waitTime = minWait + Math.random() * (maxWait - minWait);
        this.trialTimer = setTimeout(() => this.showStimulus(), waitTime);
    }

    renderOnScreenGuides() {
        const guidesBox = document.getElementById('onScreenResponseButtons');
        guidesBox.innerHTML = '';
        const config = this.getStimuliConfig();
        if (this.testType.includes('choice')) {
            (config.targets || []).forEach(stimulus => {
                const button = document.createElement('button');
                button.className = 'arena-key-btn';
                button.dataset.key = stimulus.key;
                button.innerHTML = `<span class="key-arrow">${escapeHtml(stimulus.keyLabel || stimulus.key)}</span><span class="key-label">${escapeHtml(stimulus.label || '')}</span>`;
                button.addEventListener('pointerdown', event => {
                    event.preventDefault();
                    this.handleResponse(stimulus.key, describePointer(event));
                });
                guidesBox.appendChild(button);
            });
        } else if (config.targets?.[0]) {
            const target = config.targets[0];
            const button = document.createElement('button');
            button.className = 'primary-btn';
            button.style.width = '250px';
            button.innerText = `اضغط ${target.keyLabel || translateKeys(target.key || 'Space')} / أو هنا`;
            button.addEventListener('pointerdown', event => {
                event.preventDefault();
                this.handleResponse(target.key || 'Space', describePointer(event));
            });
            guidesBox.appendChild(button);
        }
    }

    async showStimulus() {
        if (this.isStopped) return;
        const placeholder = document.getElementById('stimulusPlaceholder');

        if (this.testType.includes('visual')) {
            const stimulus = this.currentStimulusObject;
            const element = document.createElement('div');
            element.className = `stimulus-shape ${stimulus.shape || 'circle'}`;
            if (stimulus.type === 'color') element.style.backgroundColor = stimulus.val;
            else if (stimulus.type === 'image') {
                element.className = 'stimulus-shape stimulus-image-frame';
                const image = document.createElement('img');
                image.className = 'stimulus-uploaded-image';
                image.src = stimulus.val;
                image.alt = stimulus.label || 'المثير البصري';
                image.draggable = false;
                element.appendChild(image);
            }
            placeholder.appendChild(element);
            requestAnimationFrame(() => {
                if (this.isStopped || !this.waitingForStimulus) return;
                this.activateStimulus(performance.now());
            });
        } else {
            placeholder.innerHTML = '<div class="auditory-headphone-guide" style="font-size:72px;color:var(--color-primary);">🎧</div>';
            try {
                const playback = await window.appAudio?.playSoundByName(this.currentStimulusObject.val);
                if (this.isStopped || !this.waitingForStimulus) return;
                const onset = playback?.onsetPerformanceTime || performance.now();
                const delay = Math.max(0, onset - performance.now());
                this.audioOnsetTimer = setTimeout(() => this.activateStimulus(onset), delay);
            } catch (error) {
                console.error('Audio stimulus failed:', error);
                showDataStatus('تعذر تشغيل المثير الصوتي. أُوقفت المحاولة لحماية دقة النتيجة.', 'error');
                this.stop();
            }
        }
    }

    activateStimulus(onsetPerformanceTime) {
        if (this.isStopped || !this.waitingForStimulus) return;
        this.stimulusOnTime = onsetPerformanceTime;
        this.trialActive = true;
        this.waitingForStimulus = false;
        const placeholder = document.getElementById('stimulusPlaceholder');
        this.stimulusTimer = setTimeout(() => { placeholder.innerHTML = ''; }, Number(this.config.stimulusDuration) * 1000);
        this.feedbackTimer = setTimeout(() => {
            if (this.trialActive) this.handleResponse('timeout', 'system');
        }, Number(this.config.maxResponseTime) * 1000);
    }

    handleResponse(pressedKey, inputMethod = 'keyboard') {
        if ((!this.trialActive && !this.waitingForStimulus) || this.isStopped) return;
        const early = this.waitingForStimulus;
        this.trialActive = false;
        this.waitingForStimulus = false;
        clearTimeout(this.trialTimer);
        clearTimeout(this.stimulusTimer);
        clearTimeout(this.feedbackTimer);
        clearTimeout(this.audioOnsetTimer);
        document.getElementById('stimulusPlaceholder').innerHTML = '';

        const responseTime = early ? null : (performance.now() - this.stimulusOnTime) / 1000;
        let result;
        if (early) result = 'early';
        else if (this.currentRequiredKey === 'ignore') result = pressedKey === 'timeout' ? 'correct-rejection' : 'false-alarm';
        else if (pressedKey === 'timeout') result = 'miss';
        else if (pressedKey === this.currentRequiredKey) result = 'correct';
        else result = 'wrong';

        const latency = (pressedKey === 'timeout' || early) ? null : responseTime;
        const trialResult = {
            index: (this.mode === 'practice' ? this.practiceResults.length : this.results.length) + 1,
            phase: this.mode,
            includedInScore: this.mode === 'formal',
            stimulusName: this.currentStimulusObject?.label || this.currentStimulusObject?.id || 'مثير غير محدد',
            requiredKey: this.currentRequiredKey,
            actualKey: pressedKey === 'timeout' ? '' : pressedKey,
            result,
            latency,
            inputMethod,
            timestamp: new Date().toISOString()
        };
        if (inputMethod !== 'system') this.inputMethods.add(inputMethod);
        if (this.mode === 'practice') this.practiceResults.push(trialResult);
        else this.results.push(trialResult);

        const resultMeta = getTrialResultMeta(result);
        const activeDot = document.querySelectorAll('.progress-dot')[this.currentTrialIndex];
        if (activeDot) activeDot.classList.add(resultMeta.className);
        this.showTrialFeedback(result, latency);

        const feedbackEnabled = this.mode === 'practice' ? this.config.practiceFeedback : this.config.testFeedback;
        const delay = Number(this.config.interStimulus) * 1000 + (feedbackEnabled ? 400 : 0);
        this.advanceTimer = setTimeout(() => {
            this.currentTrialIndex += 1;
            this.runTrial();
        }, delay);
    }

    showTrialFeedback(result, latency) {
        const enabled = this.mode === 'practice' ? this.config.practiceFeedback : this.config.testFeedback;
        const overlay = document.getElementById('trialFeedbackOverlay');
        if (!enabled) {
            overlay.style.display = 'none';
            return;
        }
        const positive = result === 'correct' || result === 'correct-rejection';
        const meta = getTrialResultMeta(result);
        overlay.style.display = 'flex';
        document.getElementById('trialFeedbackBadge').className = `feedback-badge ${positive ? 'correct' : 'wrong'}`;
        document.getElementById('trialFeedbackIcon').innerText = positive ? '✓' : '✗';
        document.getElementById('trialFeedbackText').innerText = meta.label;
        const latencyElement = document.getElementById('trialFeedbackLatency');
        if (latency !== null) {
            latencyElement.innerText = `زمن الاستجابة: ${milliseconds(latency)} مللي ثانية`;
            latencyElement.style.display = 'block';
        } else latencyElement.style.display = 'none';
    }

    completePractice() {
        clearTimeout(this.trialTimer);
        clearTimeout(this.stimulusTimer);
        clearTimeout(this.feedbackTimer);
        clearTimeout(this.advanceTimer);
        this.trialActive = false;
        this.waitingForStimulus = false;
        document.getElementById('trialFeedbackOverlay').style.display = 'none';
        this.startFormalCountdown();
    }

    endTest() {
        const trialsCount = this.results.length;
        const responseCorrectCount = this.results.filter(result => result.result === 'correct').length;
        const correctRejectionCount = this.results.filter(result => result.result === 'correct-rejection').length;
        const correctCount = responseCorrectCount + correctRejectionCount;
        const wrongChoiceCount = this.results.filter(result => result.result === 'wrong').length;
        const missCount = this.results.filter(result => result.result === 'miss').length;
        const falseAlarmCount = this.results.filter(result => result.result === 'false-alarm').length;
        const earlyCount = this.results.filter(result => result.result === 'early').length;
        const wrongCount = wrongChoiceCount + falseAlarmCount + earlyCount;
        const errorCount = wrongCount + missCount;
        const correctLatencies = this.results
            .filter(result => result.result === 'correct' && result.latency !== null)
            .map(result => result.latency);
        const avgReactionTime = mean(correctLatencies);
        const medianReactionTime = median(correctLatencies);
        const stdDevReactionTime = sampleStdDev(correctLatencies);
        const fastestTime = correctLatencies.length ? Math.min(...correctLatencies) : 0;
        const slowestTime = correctLatencies.length ? Math.max(...correctLatencies) : 0;
        const accuracy = trialsCount ? (correctCount / trialsCount) * 100 : 0;
        const errorRate = trialsCount ? (errorCount / trialsCount) * 100 : 0;
        const elapsed = Math.max(0, Math.round((Date.now() - (this.startTime || Date.now())) / 1000));
        const duration = `${Math.floor(elapsed / 60).toString().padStart(2, '0')}:${(elapsed % 60).toString().padStart(2, '0')}`;
        const student = state.sessionStudent || this.student || {};

        const session = normalizeSession({
            id: makeEntityId('session'),
            studentId: student.id || this.student?.id || null,
            studentCode: student.code || this.student?.code || '',
            studentName: student.name || 'حالة غير مسماة',
            studentAge: student.age ?? null,
            studentGender: student.gender || '',
            studentIQ: student.iq ?? null,
            studentCategory: student.category || '',
            specialist: state.sessionSpecialist ? deepClone(state.sessionSpecialist) : null,
            testType: this.testType,
            date: state.sessionSpecialist?.date || new Date().toISOString(),
            duration,
            trialsCount,
            formalTrialsCount: trialsCount,
            practiceTrialsCount: this.practiceResults.length,
            plannedPracticeTrialsCount: this.config.practiceTrialsCount,
            practiceOpenEnded: Boolean(this.config.practiceOpenEnded),
            avgReactionTime,
            medianReactionTime,
            stdDevReactionTime,
            fastestTime,
            slowestTime,
            responseCorrectCount,
            correctRejectionCount,
            correctCount,
            wrongChoiceCount,
            wrongCount,
            missCount,
            falseAlarmCount,
            earlyCount,
            errorCount,
            accuracy,
            errorRate,
            trials: deepClone(this.results),
            practiceTrials: deepClone(this.practiceResults),
            settingsSnapshot: {
                general: deepClone(this.config),
                instruction: state.settings.instructions[this.testType] || '',
                stimuli: deepClone(this.getStimuliConfig())
            },
            inputMethod: this.inputMethods.size === 1 ? [...this.inputMethods][0] : (this.inputMethods.size > 1 ? 'mixed' : 'unknown'),
            inputMethods: [...this.inputMethods],
            deviceInfo: this.deviceInfo,
            clinicalNotes: ''
        });

        state.sessions.push(session);
        state.activeSession = session;
        state.activeStudentId = session.studentId || state.activeStudentId;
        saveData();
        updateUI();
        document.getElementById('trialFeedbackOverlay').style.display = 'none';

        if (state.testQueue.length > 0) {
            showNextTestTransition(this.testType, state.testQueue[0]);
            return;
        }

        this.showStep('arenaStepSummary');
        document.getElementById('sumTotalTrials').innerText = trialsCount;
        document.getElementById('sumPracticeTrials').innerText = this.practiceResults.length;
        document.getElementById('sumCorrectCount').innerText = correctCount;
        document.getElementById('sumAccuracyPct').innerText = `${accuracy.toFixed(1)}%`;
        document.getElementById('sumErrorPct').innerText = `${errorRate.toFixed(1)}%`;
        document.getElementById('sumAvgLatency').innerText = `${milliseconds(avgReactionTime)} مللي ثانية`;
        document.getElementById('sumMedianLatency').innerText = `${milliseconds(medianReactionTime)} مللي ثانية`;
        document.getElementById('sumStdDev').innerText = stdDevReactionTime === null ? '—' : `${milliseconds(stdDevReactionTime)} مللي ثانية`;
    }

    stop() {
        this.isStopped = true;
        clearInterval(this.countdownTimer);
        clearTimeout(this.trialTimer);
        clearTimeout(this.stimulusTimer);
        clearTimeout(this.feedbackTimer);
        clearTimeout(this.advanceTimer);
        clearTimeout(this.audioOnsetTimer);
        this.trialActive = false;
        this.waitingForStimulus = false;
        this.closeOverlay();
    }
}

// Global listener for Keyboard events to drive Active Test
window.addEventListener("keydown", (e) => {
    if (!state.currentRunningTest) return;
    const test = state.currentRunningTest;
    if (!test.trialActive && !test.waitingForStimulus) return;
    
    let pressed = e.code;
    
    // Normalize space and arrow behaviors (scrolling prevention)
    if (["Space", "ArrowUp", "ArrowDown", "ArrowRight", "ArrowLeft"].includes(e.code)) {
        e.preventDefault();
    }
    
    // Arabic keyboard mapping helpers
    const arabicKeyMap = {
        'ش': 'KeyA', 'a': 'KeyA', 'A': 'KeyA',
        'ل': 'KeyB', 'b': 'KeyB', 'B': 'KeyB',
        'ؤ': 'KeyC', 'c': 'KeyC', 'C': 'KeyC',
        'ي': 'KeyD', 'd': 'KeyD', 'D': 'KeyD',
        'ث': 'KeyE', 'e': 'KeyE', 'E': 'KeyE',
        'ب': 'KeyF', 'f': 'KeyF', 'F': 'KeyF',
        'ص': 'KeyW', 'w': 'KeyW', 'W': 'KeyW',
        'س': 'KeyS', 's': 'KeyS', 'S': 'KeyS'
    };
    
    if (arabicKeyMap[e.key]) {
        pressed = arabicKeyMap[e.key];
    }
    
    // Standardize Space alias
    if (e.code === "Space") {
        pressed = "Space";
    }

    if (pressed) {
        state.currentRunningTest.handleResponse(pressed);
    }
});

// Launch active test helper
function startTestEngine(testType) {
    state.currentRunningTest = new TestEngine(testType);
    state.currentRunningTest.init();
}

// Transition screen for multiple tests
function showNextTestTransition(completedType, nextType) {
    if (state.currentRunningTest) {
        state.currentRunningTest.showStep("arenaStepNextTest");
    }
    
    document.getElementById("nextTestCompletedLabel").innerText = `تم الانتهاء من اختبار ${getTestArabicName(completedType)} بنجاح!`;
    document.getElementById("nextTestUpcomingLabel").innerText = `الاختبار التالي سيكون:`;
    document.getElementById("nextTestNameLabel").innerText = getTestArabicName(nextType);
    document.getElementById("nextTestInstructionText").innerHTML = sanitizeInstructionHtml(state.settings.instructions[nextType] || "استعد للاختبار القادم.");
}

// Between-tests transition button
document.getElementById("proceedNextTestBtn").addEventListener("click", () => {
    startNextTestFromQueue();
});

document.getElementById("stopSessionBtn").addEventListener("click", () => {
    state.testQueue = [];
    if (state.currentRunningTest) {
        state.currentRunningTest.closeOverlay();
        state.currentRunningTest = null;
    }
    switchView("results-view");
});

// Test Arena dialog button controllers
document.getElementById("arenaStartBtn").addEventListener("click", () => {
    if (state.currentRunningTest) {
        state.currentRunningTest.startSessionFlow();
    }
});

document.getElementById("finishPracticeNowBtn")?.addEventListener("click", () => {
    if (state.currentRunningTest?.mode === 'practice') state.currentRunningTest.completePractice();
});

document.getElementById("arenaCancelBtn").addEventListener("click", () => {
    if (state.currentRunningTest) {
        state.currentRunningTest.stop();
        state.currentRunningTest = null;
    }
});

document.getElementById("arenaStopMidTestBtn").addEventListener("click", () => {
    if (state.currentRunningTest) {
        state.currentRunningTest.stop();
        state.currentRunningTest = null;
    }
});

document.getElementById("summaryCloseBtn").addEventListener("click", () => {
    if (state.currentRunningTest) {
        state.currentRunningTest.closeOverlay();
        state.currentRunningTest = null;
    }
});

document.getElementById("summaryViewReportBtn").addEventListener("click", () => {
    if (state.currentRunningTest) {
        state.currentRunningTest.closeOverlay();
        state.currentRunningTest = null;
    }
    switchView("results-view");
    document.getElementById('btnIndividualTab')?.click();
    populateSessionsList();
    if (state.activeSession) {
        const studentSelect = document.getElementById('historyStudentSelect');
        const sessionSelect = document.getElementById('historySessionSelect');
        if (studentSelect) studentSelect.value = state.activeSession.studentId || '';
        if (sessionSelect) sessionSelect.value = state.activeSession.id;
        loadSessionReport(state.activeSession);
    }
});

document.getElementById("summaryRetryBtn").addEventListener("click", () => {
    if (!state.currentRunningTest) return;
    const type = state.currentRunningTest.testType;
    state.currentRunningTest.closeOverlay();
    state.currentRunningTest = null;
    startTestEngine(type);
});
