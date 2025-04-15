'use client'

import { useRef, useState, useEffect } from "react"
import { FaMicrophone, FaMicrophoneSlash } from "react-icons/fa"
import { useMicVAD } from "@ricky0123/vad-react"

export default function VoiceChat() {
  const [recording, setRecording] = useState(false)
  const [status, setStatus] = useState("Idle")
  const [aiAudioUrl, setAiAudioUrl] = useState<string | null>(null)
  const [isAIPlaying, setIsAIPlaying] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const silenceTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const recordingRef = useRef(false)

  // Update recording ref when recording state changes
  useEffect(() => {
    recordingRef.current = recording
  }, [recording])

  // Use the VAD hook
  const vad = useMicVAD({
    onSpeechStart: () => {
      console.log("Voice started")
      setStatus("Voice detected...")
      // Clear any existing silence timeout
      if (silenceTimeoutRef.current) {
        clearTimeout(silenceTimeoutRef.current)
        silenceTimeoutRef.current = null
      }
    },
    onSpeechEnd: () => {
      console.log("Voice stopped")
      // Wait a bit before stopping to catch any final words
      if (recording && !isAIPlaying) {
        silenceTimeoutRef.current = setTimeout(() => {
          if (recording && !isAIPlaying) {
            stopRecording()
          }
          silenceTimeoutRef.current = null
        }, 900) // 0.9 seconds of silence before stopping
      }
    },
    // Optional configuration
    positiveSpeechThreshold: 0.8,
    negativeSpeechThreshold: 0.3,
    minSpeechFrames: 5,
    preSpeechPadFrames: 10,
    redemptionFrames: 30
  })

  // Clean up resources when component unmounts
  useEffect(() => {
    return () => {
      cleanupAudio()
    }
  }, [])

  // Set up audio ended event listener
  useEffect(() => {
    const setupAudioEndedListener = () => {
      const audioElement = audioRef.current
      
      if (audioElement) {
        const handleAudioEnded = () => {
          console.log("AI response finished playing", { isRecording: recordingRef.current })
          setIsAIPlaying(false)
          setStatus("Listening...")
          
          // Resume listening after AI response ends with a small delay
          setTimeout(() => {
            console.log("Attempting to restart recording")
            if (!recordingRef.current) {
              startRecording()
            }
          }, 300)
        }
        
        // Remove any existing listeners first to avoid duplicates
        audioElement.removeEventListener('ended', handleAudioEnded)
        // Add the listener
        audioElement.addEventListener('ended', handleAudioEnded)
        
        return () => {
          audioElement.removeEventListener('ended', handleAudioEnded)
        }
      }
    }
    
    // Setup the listener initially and whenever aiAudioUrl changes
    const cleanup = setupAudioEndedListener()
    return cleanup
  }, [aiAudioUrl]) // Re-run when aiAudioUrl changes

  // Clean up all audio resources
  const cleanupAudio = () => {
    // Clear silence timeout if active
    if (silenceTimeoutRef.current) {
      clearTimeout(silenceTimeoutRef.current)
      silenceTimeoutRef.current = null
    }

    // Stop media recorder if active
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop()
      } catch (e) {
        console.error("Error stopping media recorder:", e)
      }
    }

    // Stop all tracks in the media stream
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop())
      streamRef.current = null
    }

    setRecording(false)
  }

  // Start recording
  const startRecording = async () => {
    console.log("Starting recording...", new Date().toISOString())
    try {
      setStatus("Listening...")
      audioChunksRef.current = []

      // Request microphone access
      const stream = await navigator.mediaDevices.getUserMedia({ audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false
      } })
      streamRef.current = stream
      
      // Create media recorder
      const mediaRecorder = new MediaRecorder(stream)
      mediaRecorderRef.current = mediaRecorder
      
      // Set up event handlers
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data)
        }
      }
      
      mediaRecorder.onstop = () => {
        if (audioChunksRef.current.length > 0) {
          const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' })
          handleAudioData(audioBlob)
        }
      }
      
      // Start recording
      mediaRecorder.start(100) // Collect data in 100ms chunks
      setRecording(true)
      
      // Start VAD listening
      await vad.start()
    } catch (error) {
      console.error("Error starting recording:", error)
      setStatus("Error: Could not access microphone")
      cleanupAudio()
    }
  }

  // Stop recording (manual or after silence)
  const stopRecording = () => {
    if (!isAIPlaying) {
      setStatus("Processing...")
      
      // Stop VAD listening
      vad.pause()
      
      // Clear silence timeout if active
      if (silenceTimeoutRef.current) {
        clearTimeout(silenceTimeoutRef.current)
        silenceTimeoutRef.current = null
      }
      
      // Stop the media recorder
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try {
          mediaRecorderRef.current.stop()
        } catch (e) {
          console.error("Error stopping media recorder:", e)
        }
      }
      
      // Stop all tracks in the media stream
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop())
      }
      
      setRecording(false)
    }
  }

  // Handle the recorded audio data
  const handleAudioData = async (blob: Blob) => {
    setStatus("Processing your voice...")
    try {
      await sendAudioToBackend(blob)
    } catch (error) {
      console.error("Error processing audio:", error)
      setStatus("Error: Could not process audio")
      // Try to restart listening after error
      setTimeout(() => {
        if (!recording && !isAIPlaying) {
          startRecording()
        }
      }, 2000)
    }
  }

  // Send audio to backend and play AI response
  const sendAudioToBackend = async (blob: Blob) => {
    setStatus("AI is thinking...")
    
    try {
      const formData = new FormData()
      formData.append("audio", blob, "audio.webm")

      const response = await fetch("http://localhost:8000/voice-chat", {
        method: "POST",
        body: formData,
      })

      if (!response.ok) {
        throw new Error(`Server responded with ${response.status}`)
      }

      // Stream and process the audio response
      const audioChunks: Uint8Array[] = []
      const reader = response.body!.getReader()

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        audioChunks.push(value)
      }

      const audioBlob = new Blob(audioChunks, { type: "audio/mpeg" })
      const url = URL.createObjectURL(audioBlob)
      
      setAiAudioUrl(url)
      setStatus("AI is speaking...")
      setIsAIPlaying(true)
      
      // Play the audio automatically
      if (audioRef.current) {
        audioRef.current.src = url
        audioRef.current.play().catch(err => {
          console.error("Error auto-playing audio:", err)
          setStatus("Click to play AI response")
          setIsAIPlaying(false)
          
          // If autoplay fails, still try to restart listening
          setTimeout(() => {
            if (!recording) {
              startRecording()
            }
          }, 1000)
        })
      }
      
      // Failsafe: If for some reason the ended event doesn't fire,
      // restart listening after a maximum response time
      const maxResponseTime = 60000 // 60 seconds max for AI response
      setTimeout(() => {
        if (isAIPlaying && !recording) {
          console.log("Failsafe: Resuming listening after timeout")
          setIsAIPlaying(false)
          startRecording()
        }
      }, maxResponseTime)
      
    } catch (error) {
      console.error("Error sending audio to backend:", error)
      setStatus("Error communicating with AI")
      
      // Try to restart listening after error
      setTimeout(() => {
        if (!recording && !isAIPlaying) {
          startRecording()
        }
      }, 2000)
    }
  }

  // Get the loading and error states from the VAD hook
  const { loading: vadLoading, errored: vadErrored } = vad

  // Update status based on VAD state
  useEffect(() => {
    if (vadLoading && recording) {
      setStatus("Initializing voice detection...")
    } else if (vadErrored) {
      setStatus("Error: Voice detection failed")
      cleanupAudio()
    }
  }, [vadLoading, vadErrored, recording])

  // Toggle recording manually
  const toggleRecording = () => {
    if (isAIPlaying) {
      // If AI is speaking, just stop it
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current.currentTime = 0
      }
      setIsAIPlaying(false)
      setStatus("AI response stopped")
      
      // Restart listening
      setTimeout(() => {
        if (!recording) {
          startRecording()
        }
      }, 500)
    } else {
      // Normal toggle behavior
      if (recording) {
        stopRecording()
      } else {
        startRecording()
      }
    }
  }

  return (
    <main className="bg-gray-900 min-h-screen flex flex-col items-center justify-center text-white relative">
      <div className="flex flex-col items-center justify-center w-full max-w-md mx-auto p-4 relative">
        <h1 className="text-2xl font-bold mb-8">AI Voice Chat</h1>
        
        <button
          onClick={toggleRecording}
          disabled={vadLoading && !isAIPlaying}
          className={`flex items-center justify-center rounded-full w-24 h-24 text-4xl transition-all duration-300 shadow-lg
            ${isAIPlaying 
              ? "bg-blue-600 hover:bg-blue-700 animate-pulse" 
              : recording 
                ? "bg-red-600 hover:bg-red-700 animate-pulse" 
                : vadLoading 
                  ? "bg-gray-500 cursor-not-allowed"
                  : "bg-gray-700 hover:bg-gray-600"}`}
          aria-label={isAIPlaying ? "Stop AI" : recording ? "Stop recording" : "Start recording"}
        >
          {recording ? <FaMicrophone /> : <FaMicrophoneSlash />}
        </button>
        
        <div className="mt-12 w-full">
          {aiAudioUrl && (
            <audio 
              ref={audioRef}
              src={aiAudioUrl} 
              controls 
              className="w-full mt-4"
              autoPlay
            />
          )}
        </div>
        
        <div className="bottom-8 left-0 right-0 text-center text-gray-400 text-base">
          {status}
        </div>
      </div>
    </main>
  )
}
