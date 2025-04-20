'use client'

import { useRef, useState, useEffect } from "react"
import { FaMicrophone, FaMicrophoneSlash } from "react-icons/fa"
import { useMicVAD } from "@ricky0123/vad-react"

interface Message {
  type: 'user' | 'ai'
  text: string
  isLive?: boolean
}

export default function VoiceChat() {
  const [recording, setRecording] = useState(false)
  const [status, setStatus] = useState("Idle")
  const [aiAudioUrl, setAiAudioUrl] = useState<string | null>(null)
  const [isAIPlaying, setIsAIPlaying] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [liveTranscript, setLiveTranscript] = useState("")
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const silenceTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const recordingRef = useRef(false)
  const playPromiseRef = useRef<Promise<void> | null>(null)
  const recordingStartTimeRef = useRef<number | null>(null)
  const chatContainerRef = useRef<HTMLDivElement | null>(null)
  const currentChunkRef = useRef<Blob[]>([])
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    // Initialize WebSocket connection
    wsRef.current = new WebSocket('ws://localhost:8000/ws')
    
    wsRef.current.onopen = () => {
      console.log('WebSocket connected')
      setStatus('Connected to server')
    }
    
    wsRef.current.onmessage = async (event) => {
      const data = JSON.parse(event.data)
      
      if (data.type === 'transcription') {
        setLiveTranscript(data.text)
      } else if (data.type === 'ai_response') {
        // Add messages to chat
        setMessages(prev => [
          ...prev, 
          { type: 'user', text: liveTranscript },
          { type: 'ai', text: data.text }
        ])
        setLiveTranscript("")
        
        // Handle audio response
        const audioBlob = await fetch(`data:audio/mpeg;base64,${data.audio}`).then(r => r.blob())
        const url = URL.createObjectURL(audioBlob)
        setAiAudioUrl(url)
        setStatus("AI is speaking...")
        setIsAIPlaying(true)
        
        if (audioRef.current) {
          audioRef.current.src = url
          try {
            await audioRef.current.play()
          } catch (err) {
            console.error("Error auto-playing audio:", err)
            setStatus("Click to play AI response")
            setIsAIPlaying(false)
          }
        }
      } else if (data.type === 'error') {
        console.error("Server error:", data.message)
        setStatus(`Error: ${data.message}`)
      }
    }
    
    wsRef.current.onerror = (error) => {
      console.error('WebSocket error:', error)
      setStatus('Connection error')
    }
    
    wsRef.current.onclose = () => {
      console.log('WebSocket closed')
      setStatus('Disconnected from server')
    }
    
    return () => {
      if (wsRef.current) {
        wsRef.current.close()
      }
    }
  }, [])

  useEffect(() => {
    recordingRef.current = recording
    if (recording) {
      recordingStartTimeRef.current = Date.now()
    }
  }, [recording])

  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight
    }
  }, [messages, liveTranscript])

  // Use the VAD hook with WebSocket
  const vad = useMicVAD({
    onSpeechStart: () => {
      console.log("Voice started")
      setStatus("Voice detected...")
      currentChunkRef.current = []
      if (silenceTimeoutRef.current) {
        clearTimeout(silenceTimeoutRef.current)
        silenceTimeoutRef.current = null
      }
    },
    onSpeechEnd: async (audioData) => {
      console.log("Voice stopped")
      if (recording && !isAIPlaying) {
        try {
          // Create a MediaRecorder to encode the audio
          const audioContext = new AudioContext()
          const audioBuffer = audioContext.createBuffer(1, audioData.length, 16000)
          audioBuffer.copyToChannel(audioData, 0)
          
          const source = audioContext.createBufferSource()
          source.buffer = audioBuffer
          
          const mediaStream = audioContext.createMediaStreamDestination()
          source.connect(mediaStream)
          
          const mediaRecorder = new MediaRecorder(mediaStream.stream, {
            mimeType: 'audio/webm;codecs=opus'
          })
          
          const chunks: Blob[] = []
          mediaRecorder.ondataavailable = (e) => chunks.push(e.data)
          
          return new Promise<void>((resolve) => {
            mediaRecorder.onstop = async () => {
              const blob = new Blob(chunks, { type: 'audio/webm' })
              
              if (wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(await blob.arrayBuffer())
                setStatus("Processing...")
              } else {
                console.error("WebSocket is not connected")
                setStatus("Error: Not connected to server")
              }
              resolve()
            }
            
            // Start recording and play the audio
            mediaRecorder.start()
            source.start()
            
            // Calculate duration based on the audio buffer length
            const duration = audioBuffer.length / audioBuffer.sampleRate * 1000 // Convert to milliseconds
            console.log("Audio duration:", duration, "ms")
            
            // Stop after the full duration plus a small buffer
            setTimeout(() => {
              mediaRecorder.stop()
              source.stop()
              audioContext.close()
            }, duration + 100) // Add 100ms buffer
          })
        } catch (error) {
          console.error("Error processing audio:", error)
          setStatus("Error processing audio")
        }
      }
      
      silenceTimeoutRef.current = setTimeout(() => {
        if (recording && !isAIPlaying) {
          stopRecording(false)
        }
        silenceTimeoutRef.current = null
      }, 1000)
    },
    onVADMisfire: () => {
      // Handle VAD misfire if needed
    },
    positiveSpeechThreshold: 0.8,
    negativeSpeechThreshold: 0.3,
    minSpeechFrames: 5,
    preSpeechPadFrames: 10,
    redemptionFrames: 30
  })

  const cleanupAudio = () => {
    if (silenceTimeoutRef.current) {
      clearTimeout(silenceTimeoutRef.current)
      silenceTimeoutRef.current = null
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop())
      streamRef.current = null
    }

    setRecording(false)
    recordingStartTimeRef.current = null
    setLiveTranscript("")
    currentChunkRef.current = []
  }

  const startRecording = async () => {
    console.log("Starting recording...", new Date().toISOString())
    try {
      setStatus("Listening...")
      currentChunkRef.current = []
      setLiveTranscript("")

      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false
        } 
      })
      streamRef.current = stream
      
      setRecording(true)
      recordingStartTimeRef.current = Date.now()
      
      await vad.start()
    } catch (error) {
      console.error("Error starting recording:", error)
      setStatus("Error: Could not access microphone")
      cleanupAudio()
    }
  }

  const stopRecording = (isManual: boolean = true) => {
    if (!isAIPlaying) {
      const recordingDuration = recordingStartTimeRef.current 
        ? Date.now() - recordingStartTimeRef.current 
        : 0

      if (isManual && recordingDuration < 5000) {
        setStatus("Recording too short")
        cleanupAudio()
        setTimeout(() => setStatus("Idle"), 2000)
        return
      }

      setStatus("Processing...")
      vad.pause()
      cleanupAudio()
    }
  }

  const toggleRecording = () => {
    if (isAIPlaying) {
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current.currentTime = 0
      }
      setIsAIPlaying(false)
      setStatus("AI response stopped")
    } else {
      if (recording) {
        stopRecording(true)
      } else {
        startRecording()
      }
    }
  }

  return (
    <main className="bg-gray-900 min-h-screen flex flex-col items-center justify-center text-white relative">
      <div className="flex flex-col items-center justify-center w-full max-w-2xl mx-auto p-4 relative">
        <h1 className="text-2xl font-bold mb-8">AI Voice Chat</h1>
        
        {/* Chat container */}
        <div 
          ref={chatContainerRef}
          className="w-full bg-gray-800 rounded-lg p-4 mb-8 h-[400px] overflow-y-auto flex flex-col gap-4"
        >
          {messages.map((message, index) => (
            <div 
              key={index} 
              className={`flex ${message.type === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div 
                className={`max-w-[80%] p-3 rounded-lg ${
                  message.type === 'user' 
                    ? 'bg-blue-600 text-white ml-auto' 
                    : 'bg-gray-700 text-white'
                }`}
              >
                {message.text}
              </div>
            </div>
          ))}
          {liveTranscript && (
            <div className="flex justify-end">
              <div className="max-w-[80%] p-3 rounded-lg bg-blue-600/50 text-white ml-auto">
                {liveTranscript}
              </div>
            </div>
          )}
        </div>
        
        {/* Controls */}
        <div className="w-full flex flex-col items-center gap-4">
          <button
            onClick={toggleRecording}
            disabled={false}
            className={`flex items-center justify-center rounded-full w-16 h-16 text-2xl transition-all duration-300 shadow-lg
              ${isAIPlaying 
                ? "bg-blue-600 hover:bg-blue-700 animate-pulse" 
                : recording 
                  ? "bg-red-600 hover:bg-red-700 animate-pulse" 
                  : "bg-gray-700 hover:bg-gray-600"}`}
            aria-label={isAIPlaying ? "Stop AI" : recording ? "Stop recording" : "Start recording"}
          >
            {recording ? <FaMicrophone /> : <FaMicrophoneSlash />}
          </button>
          
          {aiAudioUrl && (
            <audio 
              ref={audioRef}
              src={aiAudioUrl} 
              controls 
              className="w-full"
              autoPlay
              onEnded={() => {
                setIsAIPlaying(false)
                setStatus("Idle")
              }}
            />
          )}
          
          <div className="text-center text-gray-400 text-sm">
            {status}
          </div>
        </div>
      </div>
    </main>
  )
}
