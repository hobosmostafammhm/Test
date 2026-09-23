window.InitUserScripts = function()
{
var player = GetPlayer();
var object = player.object;
var once = player.once;
var addToTimeline = player.addToTimeline;
var setVar = player.SetVar;
var getVar = player.GetVar;
var update = player.update;
var pointerX = player.pointerX;
var pointerY = player.pointerY;
var showPointer = player.showPointer;
var hidePointer = player.hidePointer;
var slideWidth = player.slideWidth;
var slideHeight = player.slideHeight;
var getKeyDown = player.getKeyDown;
var keydown = player.keydown;
var keyup = player.keyup;
window.Script71 = function()
{
  window.QApp = (function () {

    const ayahsConfig = {
        1: ["قُلْ", "أَعُوذُ", "بِرَبِّ", "الْفَلَقِ"],
        2: ["مِنْ", "شَرِّ", "مَا", "خَلَقَ"],
        3: ["وَمِنْ", "شَرِّ", "غَاسِقٍ", "إِذَا", "وَقَبَ"],
        4: ["وَمِنْ", "شَرِّ", "النَّفَّاثَاتِ", "فِي", "الْعُقَدِ"],
        5: ["وَمِنْ", "شَرِّ", "حَاسِدٍ", "إِذَا", "حَسَدَ"]
    };
    const TOTAL_AYAHS = 5;
    const SILENCE_TIMEOUT_MS = 7000;
    const MAX_DURATION_MS = 10000;
    const LAST_WORD_STABILIZE_MS = 600;
    const FALLBACK_ANCHOR_MAX_LEVEL = 2;
    const AUDIO_FINALIZE_SAFETY_MS = 3000;
    const RECOGNITION_START_RETRY_MS = 150;
    const RECOGNITION_START_MAX_ATTEMPTS = 5;

    var player = GetPlayer();

    var state = {
        recognition: null,
        currentAyah: 1,
        expectedWords: ayahsConfig[1],
        wordVarPrefix: "Ayah1Word",
        priorSessionsWords: [],
        currentSessionWords: [],
        ayahStartIndex: 0,
        alignmentStart: -1,
        wordsEvaluated: 0,
        lastWordTimer: null,
        silenceTimer: null,
        maxDurationTimer: null,
        hasSpokenAnything: false,
        manualStopNoRestart: false,
        initialized: false,
        mediaStream: null,
        mediaRecorder: null,
        audioChunks: [],
        recordingUrl: null,
        audioFinalizeSafetyTimer: null,
        completionSignaled: false,
        currentAudio: null
    };

    function normalizeArabic(text) {
        return text
            .replace(/[\u064B-\u0652]/g, "")
            .replace(/[إأآا]/g, "ا")
            .replace(/\s+/g, " ")
            .trim();
    }

    function isVarTrue(value) {
        return value === true || value === "true";
    }

    function getAllSpokenWords() {
        return state.priorSessionsWords.concat(state.currentSessionWords);
    }

    function updateLiveTranscriptDisplay() {
        const allWords = getAllSpokenWords();
        const currentAyahWords = allWords.slice(state.ayahStartIndex);
        if (currentAyahWords.length > 0) {
            player.SetVar("LiveTranscriptDisplay", currentAyahWords.join(" "));
        }
    }

    function clearAllTimers() {
        if (state.lastWordTimer) { clearTimeout(state.lastWordTimer); state.lastWordTimer = null; }
        if (state.silenceTimer) { clearTimeout(state.silenceTimer); state.silenceTimer = null; }
        if (state.maxDurationTimer) { clearTimeout(state.maxDurationTimer); state.maxDurationTimer = null; }
    }

    function resetAllWordsHidden() {
        const expectedWords = state.expectedWords;
        const wordVarPrefix = state.wordVarPrefix;
        for (let k = 0; k < expectedWords.length; k++) {
            player.SetVar(wordVarPrefix + (k + 1) + "State", "");
        }
        state.wordsEvaluated = 0;
    }

    function finalizeRemainingWords() {
        const allWords = getAllSpokenWords();
        const expectedWords = state.expectedWords;
        const wordVarPrefix = state.wordVarPrefix;
        while (state.wordsEvaluated < expectedWords.length) {
            const spokenPosition = state.alignmentStart + state.wordsEvaluated;
            let isMatch = false;
            if (state.alignmentStart !== -1 && spokenPosition < allWords.length) {
                const spokenWord = allWords[spokenPosition];
                const targetNormalized = normalizeArabic(expectedWords[state.wordsEvaluated]);
                isMatch = (spokenWord === targetNormalized);
            }
            player.SetVar(wordVarPrefix + (state.wordsEvaluated + 1) + "State", isMatch ? "Correct" : "Incorrect");
            state.wordsEvaluated++;
        }
    }

    function findAnchor(allWords, searchFrom, expectedWords) {
        const maxLevel = Math.min(FALLBACK_ANCHOR_MAX_LEVEL, expectedWords.length - 2);
        for (let level = 0; level <= maxLevel; level++) {
            const target = normalizeArabic(expectedWords[level]);
            let latestIndex = -1;
            for (let i = searchFrom; i < allWords.length; i++) {
                if (allWords[i] === target) latestIndex = i;
            }
            if (latestIndex !== -1) {
                return { level: level, position: latestIndex };
            }
        }
        return null;
    }

    function tryMatchWords() {
        const allWords = getAllSpokenWords();
        const expectedWords = state.expectedWords;
        const wordVarPrefix = state.wordVarPrefix;

        player.SetVar(
            "DebugTranscript",
            allWords.join(" | ") + " (ayah=" + state.currentAyah +
            ", alignmentStart=" + state.alignmentStart +
            ", ayahStartIndex=" + state.ayahStartIndex + ")"
        );

        updateLiveTranscriptDisplay();

        const anchor = findAnchor(allWords, state.ayahStartIndex, expectedWords);

        if (anchor) {
            const candidateAlignmentStart = anchor.position - anchor.level;
            if (candidateAlignmentStart > state.alignmentStart) {
                state.alignmentStart = candidateAlignmentStart;
                resetAllWordsHidden();
                for (let s = 0; s < anchor.level; s++) {
                    player.SetVar(wordVarPrefix + (s + 1) + "State", "Incorrect");
                }
                state.wordsEvaluated = anchor.level;
                if (state.lastWordTimer) { clearTimeout(state.lastWordTimer); state.lastWordTimer = null; }
            }
        }

        if (state.alignmentStart === -1) return;

        for (let k = state.wordsEvaluated; k < expectedWords.length; k++) {

            const spokenPosition = state.alignmentStart + k;
            const isLastWord = (k === expectedWords.length - 1);

            if (spokenPosition >= allWords.length) break;

            if (isLastWord) {
                const spokenWord = allWords[spokenPosition];
                const targetNormalized = normalizeArabic(expectedWords[k]);
                const isMatch = (spokenWord === targetNormalized);

                if (state.lastWordTimer) clearTimeout(state.lastWordTimer);
                state.lastWordTimer = setTimeout(function () {
                    player.SetVar(wordVarPrefix + (k + 1) + "State", isMatch ? "Correct" : "Incorrect");
                    state.wordsEvaluated = expectedWords.length;
                    player.SetVar("Ayah" + state.currentAyah + "Completed", true);
                    advanceToNextAyahOrFinish(false);
                }, LAST_WORD_STABILIZE_MS);
                break;

            } else {
                if (spokenPosition + 1 < allWords.length) {
                    const spokenWord = allWords[spokenPosition];
                    const targetNormalized = normalizeArabic(expectedWords[k]);
                    const isMatch = (spokenWord === targetNormalized);
                    player.SetVar(wordVarPrefix + (k + 1) + "State", isMatch ? "Correct" : "Incorrect");
                    state.wordsEvaluated = k + 1;
                } else break;
            }
        }
    }

    function safeStartRecognition(attemptsLeft) {
        try {
            state.recognition.start();
        } catch (e) {
            if (attemptsLeft > 0) {
                setTimeout(function () {
                    safeStartRecognition(attemptsLeft - 1);
                }, RECOGNITION_START_RETRY_MS);
            } else {
                player.SetVar(
                    "LastErrorDetails",
                    "RecognitionStartFailedAfterRetries: " + e.message
                );
                player.SetVar("RecordingStarted", false);
            }
        }
    }

    function armAyahTimers() {
        state.hasSpokenAnything = false;
        player.SetVar("SilenceDetected", false);
        player.SetVar("MaxDurationExceeded", false);

        state.silenceTimer = setTimeout(function () {
            if (!state.hasSpokenAnything) {
                var alreadyRetried = isVarTrue(player.GetVar("SilenceRetryUsed"));
                if (!alreadyRetried) {
                    player.SetVar("SilenceRetryUsed", true);
                    player.SetVar("SilenceDetected", true);
                    pauseForRetry();
                } else {
                    finalizeRemainingWords();
                    player.SetVar("Ayah" + state.currentAyah + "SkippedDueToSilence", true);
                    player.SetVar("Ayah" + state.currentAyah + "Completed", true);
                    advanceToNextAyahOrFinish(false);
                }
            }
        }, SILENCE_TIMEOUT_MS);

        state.maxDurationTimer = setTimeout(function () {
            if (state.wordsEvaluated < state.expectedWords.length) {
                finalizeRemainingWords();
                player.SetVar("MaxDurationExceeded", true);
                player.SetVar("Ayah" + state.currentAyah + "Completed", true);
                advanceToNextAyahOrFinish(false);
            }
        }, MAX_DURATION_MS);
    }

    function pauseForRetry() {
        state.manualStopNoRestart = true;
        clearAllTimers();
        player.SetVar("RecordingStarted", false);
        state.priorSessionsWords = state.priorSessionsWords.concat(state.currentSessionWords);
        state.currentSessionWords = [];
        try { state.recognition.stop(); } catch (e) {}
    }

    function calculateFinalScore() {
        let totalWords = 0;
        let correctWords = 0;
        for (let a = 1; a <= TOTAL_AYAHS; a++) {
            const wc = ayahsConfig[a].length;
            for (let w = 1; w <= wc; w++) {
                totalWords++;
                const val = player.GetVar("Ayah" + a + "Word" + w + "State");
                if (val === "Correct") correctWords++;
            }
        }
        const percentage = totalWords > 0 ? Math.round((correctWords / totalWords) * 100) : 0;
        player.SetVar("FinalScorePercentage", percentage);
    }

    function signalAllAyahsCompletedOnce() {
        if (state.completionSignaled) return;
        state.completionSignaled = true;
        if (state.audioFinalizeSafetyTimer) {
            clearTimeout(state.audioFinalizeSafetyTimer);
            state.audioFinalizeSafetyTimer = null;
        }
        player.SetVar("AllAyahsCompleted", true);
    }

    function startOrResumeAudioRecording(onSettled) {
        if (!state.mediaRecorder) {
            navigator.mediaDevices.getUserMedia({ audio: true })
                .then(function (stream) {
                    state.mediaStream = stream;
                    state.mediaRecorder = new MediaRecorder(stream);
                    state.audioChunks = [];

                    state.mediaRecorder.ondataavailable = function (event) {
                        if (event.data.size > 0) {
                            state.audioChunks.push(event.data);
                        }
                    };

                    state.mediaRecorder.onstop = function () {
                        var audioBlob = new Blob(state.audioChunks, { type: "audio/webm" });
                        state.recordingUrl = URL.createObjectURL(audioBlob);
                        player.SetVar("RecordingReadyToPlay", true);
                        if (state.mediaStream) {
                            state.mediaStream.getTracks().forEach(function (track) {
                                track.stop();
                            });
                        }
                        signalAllAyahsCompletedOnce();
                    };

                    state.mediaRecorder.start();
                    if (onSettled) onSettled();
                })
                .catch(function (error) {
                    player.SetVar(
                        "LastErrorDetails",
                        "AudioRecordingError: " + error.name + " - " + error.message
                    );
                    signalAllAyahsCompletedOnce();
                    if (onSettled) onSettled();
                });
        } else {
            if (state.mediaRecorder.state === "paused") {
                state.mediaRecorder.resume();
            }
            if (onSettled) onSettled();
        }
    }

    function pauseAudioRecording() {
        if (state.mediaRecorder && state.mediaRecorder.state === "recording") {
            state.mediaRecorder.pause();
        }
    }

    function stopAudioRecordingFinal() {
        state.audioFinalizeSafetyTimer = setTimeout(function () {
            signalAllAyahsCompletedOnce();
        }, AUDIO_FINALIZE_SAFETY_MS);

        if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") {
            state.mediaRecorder.stop();
        } else {
            signalAllAyahsCompletedOnce();
        }
    }

    function playRecording() {
        if (!state.recordingUrl) return;

        if (state.currentAudio) {
            try { state.currentAudio.pause(); } catch (e) {}
        }

        state.currentAudio = new Audio(state.recordingUrl);
        player.SetVar("AudioPlaybackInProgress", true);

        state.currentAudio.onended = function () {
            player.SetVar("AudioPlaybackInProgress", false);
        };

        state.currentAudio.onerror = function () {
            player.SetVar("AudioPlaybackInProgress", false);
        };

        state.currentAudio.play();
    }

    function stopPlayback() {
        if (state.currentAudio) {
            try {
                state.currentAudio.pause();
                state.currentAudio.currentTime = 0;
            } catch (e) {}
        }
        player.SetVar("AudioPlaybackInProgress", false);
    }

    function advanceToNextAyahOrFinish(stopRecognitionNow) {
        player.SetVar("SilenceRetryUsed", false);
        state.ayahStartIndex = getAllSpokenWords().length;
        state.alignmentStart = -1;
        state.wordsEvaluated = 0;

        var isLastAyah = (state.currentAyah >= TOTAL_AYAHS);

        if (!isLastAyah) {
            state.currentAyah += 1;
            player.SetVar("CurrentAyahNumber", state.currentAyah);
            state.expectedWords = ayahsConfig[state.currentAyah];
            state.wordVarPrefix = "Ayah" + state.currentAyah + "Word";
            resetAllWordsHidden();

            if (!stopRecognitionNow) {
                clearAllTimers();
                armAyahTimers();
            } else {
                state.manualStopNoRestart = true;
                clearAllTimers();
                player.SetVar("RecordingStarted", false);
                try { state.recognition.stop(); } catch (e) {}
            }
        } else {
            calculateFinalScore();
            state.manualStopNoRestart = true;
            clearAllTimers();
            player.SetVar("RecordingStarted", false);
            try { state.recognition.stop(); } catch (e) {}
            stopAudioRecordingFinal();
        }
    }

    function setupRecognition() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        state.recognition = new SpeechRecognition();
        state.recognition.lang = "ar-SA";
        state.recognition.continuous = true;
        state.recognition.interimResults = true;

        state.recognition.onstart = function () {
            state.currentSessionWords = [];
            player.SetVar("MicPermissionDenied", false);
            player.SetVar("RecordingStarted", true);
        };

        state.recognition.onresult = function (event) {
            let fullTranscript = "";
            for (let i = 0; i < event.results.length; i++) {
                fullTranscript += event.results[i][0].transcript + " ";
            }
            state.currentSessionWords = normalizeArabic(fullTranscript).split(" ").filter(Boolean);

            if (getAllSpokenWords().length > state.ayahStartIndex && !state.hasSpokenAnything) {
                state.hasSpokenAnything = true;
                if (state.silenceTimer) { clearTimeout(state.silenceTimer); state.silenceTimer = null; }
            }
            tryMatchWords();
        };

        state.recognition.onend = function () {
            if (state.manualStopNoRestart) return;
            if (state.wordsEvaluated < state.expectedWords.length) {
                state.priorSessionsWords = state.priorSessionsWords.concat(state.currentSessionWords);
                state.currentSessionWords = [];
                safeStartRecognition(RECOGNITION_START_MAX_ATTEMPTS);
            }
        };

        state.recognition.onerror = function (event) {
            if (event.error === "not-allowed") {
                player.SetVar("MicPermissionDenied", true);
                player.SetVar("RecordingStarted", false);
            } else if (event.error !== "no-speech") {
                player.SetVar("RecordingStarted", false);
            }
        };
    }

    function resetEverythingForFreshStart() {
        state.priorSessionsWords = [];
        state.currentSessionWords = [];
        state.currentAyah = 1;
        state.expectedWords = ayahsConfig[1];
        state.wordVarPrefix = "Ayah1Word";
        state.ayahStartIndex = 0;
        state.alignmentStart = -1;
        state.wordsEvaluated = 0;
        state.hasSpokenAnything = false;
        state.manualStopNoRestart = false;
        state.completionSignaled = false;

        if (state.currentAudio) {
            try { state.currentAudio.pause(); } catch (e) {}
            state.currentAudio = null;
        }
        player.SetVar("AudioPlaybackInProgress", false);

        if (state.audioFinalizeSafetyTimer) {
            clearTimeout(state.audioFinalizeSafetyTimer);
            state.audioFinalizeSafetyTimer = null;
        }
        if (state.recordingUrl) {
            URL.revokeObjectURL(state.recordingUrl);
        }
        if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") {
            try { state.mediaRecorder.stop(); } catch (e) {}
        }
        if (state.mediaStream) {
            state.mediaStream.getTracks().forEach(function (track) { track.stop(); });
        }
        state.mediaStream = null;
        state.mediaRecorder = null;
        state.audioChunks = [];
        state.recordingUrl = null;
        player.SetVar("RecordingReadyToPlay", false);

        player.SetVar("CurrentAyahNumber", 1);
        player.SetVar("AllAyahsCompleted", false);
        player.SetVar("RecordingStarted", false);
        player.SetVar("SilenceRetryUsed", false);
        player.SetVar("SilenceDetected", false);
        player.SetVar("MaxDurationExceeded", false);
        player.SetVar("FinalScorePercentage", 0);
        player.SetVar("DisplayedScorePercentage", 0);
        player.SetVar("LiveTranscriptDisplay", "");

        for (let a = 1; a <= TOTAL_AYAHS; a++) {
            const wc = ayahsConfig[a].length;
            for (let w = 1; w <= wc; w++) {
                player.SetVar("Ayah" + a + "Word" + w + "State", "");
            }
            player.SetVar("Ayah" + a + "Completed", false);
            player.SetVar("Ayah" + a + "SkippedDueToSilence", false);
        }

        setupRecognition();
        state.initialized = true;
    }

    function handleRecordClick() {
        if (!state.initialized) return;
        state.manualStopNoRestart = false;
        state.currentAyah = Number(player.GetVar("CurrentAyahNumber"));
        state.expectedWords = ayahsConfig[state.currentAyah];
        state.wordVarPrefix = "Ayah" + state.currentAyah + "Word";

        clearAllTimers();
        player.SetVar("MicPermissionDenied", false);

        // الإصلاح: المؤقتات (7 و10 ثواني) بتبدأ تعد بس بعد ما نتأكد من الصلاحية
        // فعليًا، مش من لحظة ضغطة الزرار — عشان وقت الموافقة اليدوية ميتاكلش من وقت الآية
        startOrResumeAudioRecording(function () {
            armAyahTimers();
            safeStartRecognition(RECOGNITION_START_MAX_ATTEMPTS);
        });
    }

    function handleStopClick() {
        if (!state.initialized || !state.recognition) return;

        state.manualStopNoRestart = true;
        clearAllTimers();
        pauseAudioRecording();

        state.priorSessionsWords = state.priorSessionsWords.concat(state.currentSessionWords);
        state.currentSessionWords = [];

        if (!state.hasSpokenAnything) {
            player.SetVar("RecordingStarted", false);
            try { state.recognition.stop(); } catch (e) {}
            return;
        }

        finalizeRemainingWords();
        player.SetVar("Ayah" + state.currentAyah + "Completed", true);
        advanceToNextAyahOrFinish(true);
    }

    function getRecordingUrl() {
        return state.recordingUrl;
    }

    resetEverythingForFreshStart();

    return {
        handleRecordClick: handleRecordClick,
        handleStopClick: handleStopClick,
        resetEverythingForFreshStart: resetEverythingForFreshStart,
        getRecordingUrl: getRecordingUrl,
        playRecording: playRecording,
        stopPlayback: stopPlayback
    };

})();
}

window.Script72 = function()
{
  window.QApp.handleRecordClick();
}

window.Script73 = function()
{
  var player = GetPlayer();

player.SetVar("MicTestRunning", true);

var checksState = {
    browserSupport: false,
    internetConnection: false,
    micAvailable: false,
    micPermission: false,
    micWorking: false,
    recordingPermission: false
};

function setCheck(varName, stateKey, isCorrect) {
    player.SetVar(varName, isCorrect ? "Correct" : "Incorrect");
    checksState[stateKey] = isCorrect;
}

function evaluateAllChecks() {
    var allPassed =
        checksState.browserSupport &&
        checksState.internetConnection &&
        checksState.micAvailable &&
        checksState.micPermission &&
        checksState.micWorking &&
        checksState.recordingPermission;

    player.SetVar("MicCheckPassed", allPassed);
}

function isSupportedBrowser() {
    var ua = navigator.userAgent;
    var isEdge = /Edg\//.test(ua);
    var isOpera = /OPR\//.test(ua);
    var isChrome = /Chrome\//.test(ua) && !isEdge && !isOpera;
    return isChrome;
}

// فحص اتصال حقيقي على مرحلتين:
// 1) navigator.onLine كفحص سريع وموثوق للحالة القطعية (مفيش شبكة خالص)
// 2) لو قالت "متصل"، نتأكد فعليًا برابط عادي (مش رابط فحص الاتصال الداخلي بتاع كروم نفسه) + كسر أي تخزين مؤقت
function checkRealInternetConnectivity(timeoutMs, onResult) {

    if (!navigator.onLine) {
        onResult(false);
        return;
    }

    var settled = false;

    var timer = setTimeout(function () {
        if (!settled) {
            settled = true;
            onResult(false);
        }
    }, timeoutMs);

    var cacheBuster = "?_=" + Date.now() + Math.random();

    fetch("https://www.google.com/favicon.ico" + cacheBuster, {
        mode: "no-cors",
        cache: "no-store"
    })
        .then(function () {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                onResult(true);
            }
        })
        .catch(function () {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                onResult(false);
            }
        });
}

function requestRecordingPermission(onSettled) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setCheck("CheckRecordingPermissionState", "recordingPermission", false);
        onSettled();
        return;
    }

    navigator.mediaDevices.getUserMedia({ audio: true })
        .then(function (stream) {
            setCheck("CheckRecordingPermissionState", "recordingPermission", true);
            stream.getTracks().forEach(function (track) {
                track.stop();
            });
            onSettled();
        })
        .catch(function (error) {
            setCheck("CheckRecordingPermissionState", "recordingPermission", false);
            player.SetVar(
                "LastErrorDetails",
                "RecordingPermissionError: " + error.name + " - " + error.message
            );
            onSettled();
        });
}

try {

    var apiExists = !!(
        window.SpeechRecognition || window.webkitSpeechRecognition
    );
    var browserSupportsSpeech = apiExists && isSupportedBrowser();

    setCheck("CheckBrowserSupportState", "browserSupport", browserSupportsSpeech);

    if (!browserSupportsSpeech) {
        setCheck("CheckInternetConnectionState", "internetConnection", false);
        setCheck("CheckMicAvailableState", "micAvailable", false);
        setCheck("CheckMicPermissionState", "micPermission", false);
        setCheck("CheckMicWorkingState", "micWorking", false);
        setCheck("CheckRecordingPermissionState", "recordingPermission", false);
        player.SetVar("MicTestRunning", false);
        evaluateAllChecks();
    } else {
        checkRealInternetConnectivity(5000, function (isOnline) {
            setCheck("CheckInternetConnectionState", "internetConnection", isOnline);

            if (!isOnline) {
                setCheck("CheckMicAvailableState", "micAvailable", false);
                setCheck("CheckMicPermissionState", "micPermission", false);
                setCheck("CheckMicWorkingState", "micWorking", false);
                setCheck("CheckRecordingPermissionState", "recordingPermission", false);
                player.SetVar("MicTestRunning", false);
                evaluateAllChecks();
                return;
            }

            requestRecordingPermission(function () {
                testMicIsActuallyWorking();
            });
        });
    }

} catch (unexpectedError) {
    player.SetVar(
        "LastErrorDetails",
        "UnexpectedScriptError: " + unexpectedError.message
    );
    player.SetVar("MicTestRunning", false);
    player.SetVar("MicCheckPassed", false);
}

function testMicIsActuallyWorking() {

    try {

        const SpeechRecognition =
            window.SpeechRecognition || window.webkitSpeechRecognition;

        const testRecognition = new SpeechRecognition();
        testRecognition.lang = "ar-SA";
        testRecognition.continuous = true;
        testRecognition.interimResults = true;

        var heardSomething = false;

        testRecognition.onresult = function () {
            if (!heardSomething) {
                heardSomething = true;
                setCheck("CheckMicAvailableState", "micAvailable", true);
                setCheck("CheckMicPermissionState", "micPermission", true);
                setCheck("CheckMicWorkingState", "micWorking", true);
                testRecognition.stop();
                evaluateAllChecks();
            }
        };

        testRecognition.onerror = function (event) {

            if (event.error === "not-allowed") {
                setCheck("CheckMicAvailableState", "micAvailable", true);
                setCheck("CheckMicPermissionState", "micPermission", false);
                setCheck("CheckMicWorkingState", "micWorking", false);
                player.SetVar("MicTestRunning", false);
                evaluateAllChecks();
                return;
            }

            if (event.error === "audio-capture") {
                setCheck("CheckMicAvailableState", "micAvailable", false);
                setCheck("CheckMicPermissionState", "micPermission", false);
                setCheck("CheckMicWorkingState", "micWorking", false);
                player.SetVar("MicTestRunning", false);
                evaluateAllChecks();
                return;
            }

            if (event.error !== "no-speech" && event.error !== "aborted") {
                player.SetVar(
                    "LastErrorDetails",
                    "MicTestError: " + event.error
                );
            }
        };

        testRecognition.onend = function () {
            if (!heardSomething) {
                setCheck("CheckMicAvailableState", "micAvailable", true);
                setCheck("CheckMicPermissionState", "micPermission", true);
                setCheck("CheckMicWorkingState", "micWorking", false);
                player.SetVar("MicTestRunning", false);
                evaluateAllChecks();
            }
        };

        testRecognition.start();

    } catch (unexpectedError) {
        player.SetVar(
            "LastErrorDetails",
            "UnexpectedMicTestError: " + unexpectedError.message
        );
        setCheck("CheckMicWorkingState", "micWorking", false);
        player.SetVar("MicTestRunning", false);
        evaluateAllChecks();
    }
}
}

window.Script74 = function()
{
  var player = GetPlayer();
var target = Number(player.GetVar("FinalScorePercentage"));

player.SetVar("DisplayedScorePercentage", 0);

var current = 0;
var totalDurationMs = 1500;
var steps = Math.max(target, 1);
var intervalMs = totalDurationMs / steps;

var counterInterval = setInterval(function () {
    current++;
    if (current >= target) {
        current = target;
        player.SetVar("DisplayedScorePercentage", current);
        clearInterval(counterInterval);
    } else {
        player.SetVar("DisplayedScorePercentage", current);
    }
}, intervalMs);
}

window.Script75 = function()
{
  window.QApp.playRecording();
}

window.Script76 = function()
{
  window.QApp.stopPlayback();
}

window.Script77 = function()
{
  var player = GetPlayer();
var target = Number(player.GetVar("FinalScorePercentage"));

player.SetVar("DisplayedScorePercentage", 0);

var current = 0;
var totalDurationMs = 1500;
var steps = Math.max(target, 1);
var intervalMs = totalDurationMs / steps;

var counterInterval = setInterval(function () {
    current++;
    if (current >= target) {
        current = target;
        player.SetVar("DisplayedScorePercentage", current);
        clearInterval(counterInterval);
    } else {
        player.SetVar("DisplayedScorePercentage", current);
    }
}, intervalMs);
}

window.Script78 = function()
{
  window.QApp.playRecording();
}

window.Script79 = function()
{
  window.QApp.stopPlayback();
}

};
