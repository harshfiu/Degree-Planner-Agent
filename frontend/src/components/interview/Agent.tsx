"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { motion, AnimatePresence } from "framer-motion";
import { Mic, MicOff, Phone, PhoneOff, Cpu, Activity, User, MessageSquare } from "lucide-react";

import { cn } from "@/lib/utils";
import { vapi } from "@/lib/vapi.sdk";
import { interviewer } from "@/constants/interview";
import { createInterviewFeedback } from "@/lib/actions/interview.action";

enum CallStatus {
    INACTIVE = "INACTIVE",
    CONNECTING = "CONNECTING",
    ACTIVE = "ACTIVE",
    FINISHED = "FINISHED",
}

const MIC_STORAGE_KEY = "interview_mic_device_id";

interface SavedMessage {
    role: "user" | "system" | "assistant";
    content: string;
}

interface AgentProps {
    userName: string;
    odId?: string;
    interviewId?: string;
    feedbackId?: string;
    type: "generate" | "interview";
    questions?: string[];
}

const Agent = ({
    userName,
    odId,
    interviewId,
    feedbackId,
    type,
    questions,
}: AgentProps) => {
    const router = useRouter();
    const [callStatus, setCallStatus] = useState<CallStatus>(CallStatus.INACTIVE);
    const [messages, setMessages] = useState<SavedMessage[]>([]);
    const [isSpeaking, setIsSpeaking] = useState(false); // AI Speaking
    const [lastMessage, setLastMessage] = useState<string>("");
    const [isGeneratingFeedback, setIsGeneratingFeedback] = useState(false);
    const [isMicMuted, setIsMicMuted] = useState(false);
    const [micLevel, setMicLevel] = useState(0); // 0..1, from Vapi's local mic meter
    const [partialTranscript, setPartialTranscript] = useState(""); // what Vapi is hearing right now
    const [showTranscript, setShowTranscript] = useState(false);

    // Microphone selection
    const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
    const [selectedMicId, setSelectedMicId] = useState<string>("");
    const [micPermission, setMicPermission] = useState<"unknown" | "granted" | "denied">("unknown");
    const [previewLevel, setPreviewLevel] = useState(0); // 0..1, test meter before the call starts
    const selectedMicIdRef = useRef("");
    selectedMicIdRef.current = selectedMicId;

    // For rendering scrolling transcript
    const scrollRef = useRef<HTMLDivElement>(null);

    const loadMics = useCallback(async (requestPermission: boolean) => {
        try {
            if (requestPermission) {
                // Device labels are only exposed after mic permission is granted
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                stream.getTracks().forEach((t) => t.stop());
            }
            const devices = await navigator.mediaDevices.enumerateDevices();
            const inputs = devices.filter((d) => d.kind === "audioinput");
            if (inputs.length === 0 || !inputs[0].label) return; // no permission yet
            setMicPermission("granted");

            // Chrome adds "default"/"communications" aliases; show only the real devices
            const real = inputs.filter((d) => d.deviceId !== "default" && d.deviceId !== "communications");
            setMics(real);

            setSelectedMicId((current) => {
                if (current && real.some((d) => d.deviceId === current)) return current;
                let saved = "";
                try { saved = localStorage.getItem(MIC_STORAGE_KEY) || ""; } catch { }
                if (saved && real.some((d) => d.deviceId === saved)) return saved;
                // Fall back to the OS default input device
                const osDefault = inputs.find((d) => d.deviceId === "default");
                const match = osDefault && real.find((d) => d.groupId === osDefault.groupId);
                return (match || real[0])?.deviceId || "";
            });
        } catch (err: any) {
            console.error("Could not list microphones:", err);
            if (err?.name === "NotAllowedError") setMicPermission("denied");
        }
    }, []);

    // Load the mic list on mount (without prompting) and whenever devices are plugged in/out
    useEffect(() => {
        loadMics(false);
        const onDeviceChange = () => loadMics(false);
        navigator.mediaDevices?.addEventListener("devicechange", onDeviceChange);
        return () => navigator.mediaDevices?.removeEventListener("devicechange", onDeviceChange);
    }, [loadMics]);

    // Live test meter for the selected mic while no call is running
    useEffect(() => {
        if (callStatus !== CallStatus.INACTIVE || !selectedMicId) {
            setPreviewLevel(0);
            return;
        }
        let cancelled = false;
        let stream: MediaStream | null = null;
        let ctx: AudioContext | null = null;
        let raf = 0;
        (async () => {
            try {
                stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: selectedMicId } } });
                if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
                ctx = new AudioContext();
                const analyser = ctx.createAnalyser();
                analyser.fftSize = 1024;
                ctx.createMediaStreamSource(stream).connect(analyser);
                const buf = new Float32Array(analyser.fftSize);
                const tick = () => {
                    analyser.getFloatTimeDomainData(buf);
                    let sum = 0;
                    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
                    setPreviewLevel(Math.min(1, Math.sqrt(sum / buf.length) * 8));
                    raf = requestAnimationFrame(tick);
                };
                tick();
            } catch (err) {
                console.error("Mic preview failed:", err);
                setPreviewLevel(0);
            }
        })();
        return () => {
            cancelled = true;
            cancelAnimationFrame(raf);
            stream?.getTracks().forEach((t) => t.stop());
            ctx?.close().catch(() => { });
        };
    }, [selectedMicId, callStatus]);

    const selectMic = (deviceId: string) => {
        setSelectedMicId(deviceId);
        try { localStorage.setItem(MIC_STORAGE_KEY, deviceId); } catch { }
        if (callStatus === CallStatus.ACTIVE) {
            vapi.setInputDevicesAsync({ audioDeviceId: deviceId }).catch((err) => {
                console.error("Failed to switch microphone:", err);
                toast.error("Couldn't switch to that microphone.");
            });
        }
    };

    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [messages, lastMessage]);

    useEffect(() => {
        const onCallStart = () => {
            setCallStatus(CallStatus.ACTIVE);
            // Vapi joins with the browser's default mic; switch to the one the user picked
            const micId = selectedMicIdRef.current;
            if (micId) {
                vapi.setInputDevicesAsync({ audioDeviceId: micId }).catch((err) => {
                    console.error("Failed to switch microphone:", err);
                    toast.error("Couldn't use the selected microphone; using the browser default.");
                });
            }
        };
        const onCallEnd = () => {
            setIsMicMuted(false);
            setMicLevel(0);
            setPartialTranscript("");
            setCallStatus(CallStatus.FINISHED);
        };

        const onMessage = (message: any) => {
            if (message.type === "transcript" && message.transcript && message.role) {
                if (message.transcriptType === "final") {
                    const newMessage = {
                        role: message.role as "user" | "system" | "assistant",
                        content: message.transcript,
                    };
                    setMessages((prev) => [...prev, newMessage]);
                    if (message.role === "user") setPartialTranscript("");
                } else if (message.role === "user") {
                    setPartialTranscript(message.transcript);
                }
                return;
            }
            // Surface call lifecycle info (e.g. why Vapi ended the call) for debugging
            if (message.type === "status-update" || message.type === "hang") {
                console.log("[vapi]", message.type, message.status ?? "", message.endedReason ?? "");
            }
        };

        const onMicLevel = (level: number) => setMicLevel(level);

        const onSpeechStart = () => setIsSpeaking(true);
        const onSpeechEnd = () => setIsSpeaking(false);

        const onError = (error: any) => {
            console.error("[vapi] error:", error);
            const msg: string =
                error?.message ||
                error?.error?.message ||
                error?.errorMsg ||
                (typeof error === "string" ? error : "");
            if (msg === "Meeting has ended") {
                setCallStatus(CallStatus.FINISHED);
                toast.error("Call ended. Generating feedback...");
                return;
            }
            toast.error(`Interview connection error${msg ? `: ${msg}` : ""}`);
        };

        const onCallStartFailed = (event: any) => {
            console.error("[vapi] call start failed:", event);
            setCallStatus(CallStatus.INACTIVE);
            toast.error(`Could not start the interview${event?.error ? `: ${event.error}` : ""}`);
        };

        vapi.on("call-start", onCallStart);
        vapi.on("call-end", onCallEnd);
        vapi.on("message", onMessage);
        vapi.on("speech-start", onSpeechStart);
        vapi.on("speech-end", onSpeechEnd);
        vapi.on("error", onError);
        vapi.on("call-start-failed", onCallStartFailed);
        vapi.on("local-volume-level", onMicLevel);

        return () => {
            vapi.off("call-start", onCallStart);
            vapi.off("call-end", onCallEnd);
            vapi.off("message", onMessage);
            vapi.off("speech-start", onSpeechStart);
            vapi.off("speech-end", onSpeechEnd);
            vapi.off("error", onError);
            vapi.off("call-start-failed", onCallStartFailed);
            vapi.off("local-volume-level", onMicLevel);
        };
    }, []);

    useEffect(() => {
        if (messages.length > 0) {
            setLastMessage(messages[messages.length - 1].content);
        }

        const handleGenerateFeedback = async (msgs: SavedMessage[]) => {
            try {
                if (!interviewId || !odId) {
                    router.push("/interview");
                    return;
                }

                setIsGeneratingFeedback(true);
                // Show loading toast (optional, loading overlay is now main indicator)
                const toastId = toast.loading("Analyzing interview performance...");

                const { success, feedbackId: id } = await createInterviewFeedback({
                    interviewId: interviewId,
                    odId: odId,
                    transcript: msgs,
                    feedbackId,
                });

                if (success && id) {
                    toast.dismiss(toastId);
                    toast.success("Feedback ready!");
                    router.push(`/interview/${interviewId}/feedback`);
                } else {
                    toast.dismiss(toastId);
                    toast.error("Failed to save feedback.");
                    router.push("/interview");
                }
            } catch (error) {
                console.error("Error generating feedback:", error);
                router.push("/interview");
            } finally {
                setIsGeneratingFeedback(false);
            }
        };

        const handleCallEnded = async () => {
            if (type === "generate") {
                router.push("/interview");
            } else {
                await handleGenerateFeedback(messages);
            }
        };

        if (callStatus === CallStatus.FINISHED) {
            handleCallEnded();
        }
    }, [messages, callStatus, feedbackId, interviewId, odId, router, type]); // Added missing dependencies

    const handleCall = async () => {
        // Check microphone access up front so a blocked/missing mic fails loudly instead of silently
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: selectedMicId ? { deviceId: { exact: selectedMicId } } : true,
            });
            // A track that starts muted gets no audio from the OS (e.g. mic muted in Windows / hardware mute key)
            const isSilent = stream.getAudioTracks().some((t) => t.muted);
            stream.getTracks().forEach((t) => t.stop());
            if (isSilent) {
                toast.error("That microphone is muted at the system level. Unmute it or pick another mic from the list.");
                return;
            }
            loadMics(false);
        } catch (err: any) {
            console.error("Microphone unavailable:", err);
            toast.error(
                err?.name === "NotAllowedError"
                    ? "Microphone access is blocked. Allow it from the icon in the address bar, then try again."
                    : "No working microphone found. Check your input device and try again."
            );
            return;
        }

        setCallStatus(CallStatus.CONNECTING);
        try {
            if (type === "generate") {
                await vapi.start(process.env.NEXT_PUBLIC_VAPI_WORKFLOW_ID!, {
                    variableValues: { username: userName, userid: odId || "" },
                });
            } else {
                let formattedQuestions = "";
                if (questions) {
                    formattedQuestions = questions.map((q) => `- ${q}`).join("\n");
                }
                await vapi.start(interviewer, {
                    variableValues: { questions: formattedQuestions },
                });
            }
        } catch (error) {
            console.error("Failed to start call:", error);
            setCallStatus(CallStatus.INACTIVE);
            toast.error("Failed to start call.");
        }
    };

    const toggleMicMute = () => {
        const next = !isMicMuted;
        vapi.setMuted(next);
        setIsMicMuted(next);
    };

    const handleDisconnect = () => {
        setCallStatus(CallStatus.FINISHED);
        vapi.stop();
    };

    return (
        <div className="flex flex-col h-[75vh] md:h-[600px] w-full bg-[#0a0a0f] rounded-3xl overflow-hidden border border-white/10 relative shadow-2xl">
            {isGeneratingFeedback && (
                <div className="absolute inset-0 z-50 bg-black/80 backdrop-blur-xl flex flex-col items-center justify-center">
                    <div className="w-24 h-24 relative mb-8">
                        <div className="absolute inset-0 border-4 border-purple-500/20 rounded-full"></div>
                        <div className="absolute inset-0 border-4 border-purple-500 border-t-transparent rounded-full animate-spin"></div>
                        <div className="absolute inset-0 flex items-center justify-center">
                            <Cpu className="w-8 h-8 text-teal-400 animate-pulse" />
                        </div>
                    </div>
                    <h3 className="text-2xl font-bold text-white mb-2 tracking-wide">Analyzing Interview</h3>
                    <p className="text-zinc-400 animate-pulse">Generating your personalized feedback...</p>
                </div>
            )}
            
            {/* Command Center Overlay */}
            <div className="absolute inset-0 pointer-events-none z-0">
                <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-purple-500/50 to-transparent opacity-20" />
                <div className="absolute bottom-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-teal-500/50 to-transparent opacity-20" />
            </div>

            {/* Header / Status Bar */}
            <div className="flex items-center justify-between px-6 py-4 bg-white/5 border-b border-white/10 z-10">
                <div className="flex items-center gap-3">
                    <div className={cn(
                        "w-2.5 h-2.5 rounded-full transition-all duration-500",
                        callStatus === CallStatus.ACTIVE ? "bg-green-500 shadow-[0_0_10px_#22c55e]" :
                            callStatus === CallStatus.CONNECTING ? "bg-yellow-500 animate-pulse" : "bg-red-500"
                    )} />
                    <span className="text-xs font-mono text-gray-400">
                        {callStatus === CallStatus.ACTIVE ? "LIVE CONNECTION" :
                            callStatus === CallStatus.CONNECTING ? "ESTABLISHING UPLINK..." : "OFFLINE"}
                    </span>
                </div>
                <div className="flex items-center gap-2 text-gray-500">
                    {/* Live mic level: lights up while your voice is being picked up */}
                    <div
                        className="flex items-center gap-1.5 px-2 py-1"
                        title={isMicMuted ? "Microphone muted" : "Microphone input level"}
                    >
                        <Activity
                            className={cn(
                                "w-4 h-4 transition-colors",
                                callStatus === CallStatus.ACTIVE && !isMicMuted && micLevel > 0.05
                                    ? "text-teal-400"
                                    : "text-gray-500"
                            )}
                        />
                        <div className="w-10 h-1.5 rounded-full bg-white/10 overflow-hidden">
                            <div
                                className="h-full bg-teal-400 transition-[width] duration-100"
                                style={{
                                    width: `${callStatus === CallStatus.ACTIVE && !isMicMuted ? Math.min(100, micLevel * 200) : 0}%`,
                                }}
                            />
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={toggleMicMute}
                        disabled={callStatus !== CallStatus.ACTIVE}
                        title={isMicMuted ? "Unmute microphone" : "Mute microphone"}
                        aria-label={isMicMuted ? "Unmute microphone" : "Mute microphone"}
                        className={cn(
                            "p-1.5 rounded-lg transition-colors hover:bg-white/10 hover:text-white disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-gray-500",
                            isMicMuted && "text-red-400"
                        )}
                    >
                        {isMicMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                    </button>
                    <button
                        type="button"
                        onClick={() => setShowTranscript((v) => !v)}
                        title={showTranscript ? "Hide transcript" : "Show transcript"}
                        aria-label={showTranscript ? "Hide transcript" : "Show transcript"}
                        className={cn(
                            "p-1.5 rounded-lg transition-colors hover:bg-white/10 hover:text-white",
                            showTranscript && "text-purple-400"
                        )}
                    >
                        <MessageSquare className="w-4 h-4" />
                    </button>
                </div>
            </div>

            {/* Main Visualizer Area */}
            <div className="flex-1 relative flex items-center justify-center bg-grid-white/[0.02] z-10">

                {/* AI AVATAR / VISUALIZER */}
                <div className="relative z-10 flex flex-col items-center">
                    <div className="relative w-48 h-48 flex items-center justify-center">
                        {/* Outer Glow Rings - Animate when AI speaks */}
                        <div className={cn(
                            "absolute inset-0 rounded-full border border-purple-500/30 transition-all duration-300",
                            isSpeaking ? "scale-150 opacity-40 blur-sm" : "scale-100 opacity-20"
                        )} />
                        <div className={cn(
                            "absolute inset-0 rounded-full border border-teal-500/30 transition-all duration-300 delay-75",
                            isSpeaking ? "scale-125 opacity-40 blur-md" : "scale-100 opacity-20"
                        )} />

                        {/* Core Visualizer */}
                        <div className="w-32 h-32 rounded-full bg-black border border-white/10 flex items-center justify-center relative overflow-hidden shadow-[0_0_30px_rgba(168,85,247,0.2)]">
                            <div className="absolute inset-0 bg-gradient-to-b from-purple-500/10 to-transparent" />

                            {/* Animated Bars */}
                            <div className="flex items-end gap-1 h-12">
                                {[1, 2, 3, 4, 5].map((i) => (
                                    <motion.div
                                        key={i}
                                        initial={{ height: "20%" }}
                                        animate={{
                                            height: isSpeaking ? ["20%", "80%", "30%", "100%", "40%"] : "10%",
                                            backgroundColor: isSpeaking ? "#a855f7" : "#334155"
                                        }}
                                        transition={{
                                            duration: 0.5,
                                            repeat: Infinity,
                                            repeatType: "reverse",
                                            delay: i * 0.1
                                        }}
                                        className="w-2 rounded-full"
                                    />
                                ))}
                            </div>
                        </div>
                    </div>

                    <div className="mt-6 text-center">
                        <h3 className="text-xl font-bold text-white tracking-widest">AI INTERVIEWER</h3>
                        <p className={cn(
                            "text-xs font-mono mt-1 transition-colors",
                            isSpeaking ? "text-purple-400 animate-pulse" : "text-gray-500"
                        )}>
                            {isSpeaking ? "• SPEAKING •" : "LISTENING..."}
                        </p>
                    </div>
                </div>

                {/* User Bubble (Bottom Right) */}
                <div className="absolute bottom-8 right-8">
                    <div className="flex items-center gap-3 bg-white/5 border border-white/10 rounded-full p-2 pr-4 backdrop-blur-md">
                        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-500 to-blue-600 flex items-center justify-center text-white font-bold">
                            <User className="w-5 h-5" />
                        </div>
                        <div className="flex flex-col">
                            <span className="text-sm font-bold text-white leading-none">{userName}</span>
                            <span className="text-[10px] text-gray-400 mt-0.5">Candidate</span>
                        </div>
                    </div>
                </div>

                {/* Full transcript panel */}
                {showTranscript && (
                    <div
                        ref={scrollRef}
                        className="absolute top-4 left-4 bottom-28 w-72 max-w-[45%] overflow-y-auto z-30 bg-black/70 backdrop-blur-md border border-white/10 rounded-2xl p-3 space-y-2"
                    >
                        {messages.length === 0 && !partialTranscript ? (
                            <p className="text-xs text-gray-500">Nothing yet. The conversation will appear here.</p>
                        ) : (
                            messages.map((m, i) => (
                                <div key={i} className={cn("text-xs leading-relaxed", m.role === "user" ? "text-indigo-300" : "text-gray-200")}>
                                    <span className="font-semibold">{m.role === "user" ? "You" : "Interviewer"}: </span>
                                    {m.content}
                                </div>
                            ))
                        )}
                        {partialTranscript && (
                            <div className="text-xs leading-relaxed text-indigo-300/70 italic">
                                <span className="font-semibold not-italic">You: </span>
                                {partialTranscript}…
                            </div>
                        )}
                    </div>
                )}

                {/* Live speech-to-text of what you're saying right now */}
                {partialTranscript && !showTranscript && (
                    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 w-[70%] max-w-xl z-20 text-center text-xs text-indigo-300/80 italic truncate">
                        Hearing: {partialTranscript}…
                    </div>
                )}

                {/* Transcript Overlay (Fade In) */}
                {messages.length > 0 && (
                    <div className="absolute bottom-24 left-1/2 -translate-x-1/2 w-[80%] max-w-2xl z-20">
                        <AnimatePresence mode="wait">
                            <motion.div
                                key={lastMessage}
                                initial={{ opacity: 0, y: 20 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -20 }}
                                className="bg-black/60 backdrop-blur-md border border-white/10 rounded-2xl p-4 text-center shadow-2xl"
                            >
                                <p className="text-gray-200 text-sm md:text-base leading-relaxed line-clamp-2">
                                    "{lastMessage}"
                                </p>
                            </motion.div>
                        </AnimatePresence>
                    </div>
                )}
            </div>

            {/* Controls Bar */}
            <div className="min-h-20 py-3 px-4 bg-white/5 border-t border-white/10 flex flex-wrap items-center justify-center gap-4 md:gap-6 z-10 relative">
                {/* Microphone picker */}
                {mics.length > 0 ? (
                    <div className="flex items-center gap-2 bg-black/40 border border-white/10 rounded-xl pl-3 pr-2 py-1.5 max-w-full">
                        <Mic className="w-4 h-4 text-gray-400 shrink-0" />
                        <select
                            value={selectedMicId}
                            onChange={(e) => selectMic(e.target.value)}
                            disabled={callStatus === CallStatus.CONNECTING}
                            aria-label="Microphone"
                            className="bg-transparent text-sm text-gray-200 outline-none max-w-[14rem] truncate cursor-pointer disabled:opacity-50"
                        >
                            {mics.map((m, i) => (
                                <option key={m.deviceId} value={m.deviceId} className="bg-[#0a0a0f]">
                                    {m.label || `Microphone ${i + 1}`}
                                </option>
                            ))}
                        </select>
                        <div
                            className="w-12 h-1.5 rounded-full bg-white/10 overflow-hidden shrink-0"
                            title="Speak to test: the bar should move"
                        >
                            <div
                                className="h-full bg-teal-400 transition-[width] duration-100"
                                style={{
                                    width: `${Math.min(
                                        100,
                                        (callStatus === CallStatus.ACTIVE ? (isMicMuted ? 0 : micLevel * 2) : previewLevel) * 100
                                    )}%`,
                                }}
                            />
                        </div>
                    </div>
                ) : (
                    <button
                        type="button"
                        onClick={() => loadMics(true)}
                        className="flex items-center gap-2 text-sm text-gray-300 bg-black/40 border border-white/10 rounded-xl px-3 py-2 hover:bg-white/10 transition-colors"
                    >
                        <Mic className="w-4 h-4" />
                        {micPermission === "denied" ? "Microphone blocked: allow it in the address bar" : "Choose microphone"}
                    </button>
                )}

                {callStatus !== CallStatus.ACTIVE ? (
                    <button
                        onClick={handleCall}
                        disabled={callStatus === CallStatus.CONNECTING}
                        className="group relative px-8 py-3 bg-purple-600 hover:bg-purple-500 text-white font-bold rounded-xl transition-all shadow-lg shadow-purple-900/40 flex items-center gap-2 overflow-hidden disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        <div className="absolute inset-0 bg-white/20 translate-y-full group-hover:translate-y-0 transition-transform duration-300" />
                        <Phone className="w-5 h-5 fill-current" />
                        {callStatus === CallStatus.CONNECTING ? "CONNECTING..." : "START INTERVIEW"}
                    </button>
                ) : (
                    <button
                        onClick={handleDisconnect}
                        className="px-8 py-3 bg-red-500/10 hover:bg-red-500/20 text-red-500 border border-red-500/50 hover:border-red-500 font-bold rounded-xl transition-all flex items-center gap-2"
                    >
                        <PhoneOff className="w-5 h-5" />
                        END CALL
                    </button>
                )}
            </div>
        </div>
    );
};

export default Agent;
