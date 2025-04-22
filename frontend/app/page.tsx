'use client'

import { useRef, useState, useEffect } from "react"
import { FaMicrophone, FaMicrophoneSlash, FaPaperPlane, FaCog } from "react-icons/fa"
import { useMicVAD } from "@ricky0123/vad-react"

interface Message {
  type: 'user' | 'ai'
  text: string
  pending?: boolean
}

// Input modes to track which method the user is using
type InputMode = 'voice' | 'text' | 'idle';

interface AudioDevice {
  deviceId: string;
  label: string;
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
  const [shouldClearTranscript, setShouldClearTranscript] = useState(false)
  const lastTranscriptRef = useRef("")
  const [displayedText, setDisplayedText] = useState("")
  const animationRef = useRef<NodeJS.Timeout | null>(null)
  const [textInput, setTextInput] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)
  const [inputMode, setInputMode] = useState<InputMode>('idle')
  const [audioDevices, setAudioDevices] = useState<AudioDevice[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("")
  const [showDeviceSelector, setShowDeviceSelector] = useState(false)

  // Load available audio input devices
  useEffect(() => {
    async function getAudioDevices() {
      try {
        // First request permission to access devices
        await navigator.mediaDevices.getUserMedia({ audio: true })
        
        // Then enumerate devices
        const devices = await navigator.mediaDevices.enumerateDevices()
        const audioInputs = devices
          .filter(device => device.kind === 'audioinput')
          .map(device => ({
            deviceId: device.deviceId,
            label: device.label || `Microphone ${device.deviceId.slice(0, 5)}...`
          }))
        
        setAudioDevices(audioInputs)
        
        // Select the first device by default if none is selected
        if (audioInputs.length > 0 && !selectedDeviceId) {
          setSelectedDeviceId(audioInputs[0].deviceId)
        }
      } catch (err) {
        console.error("Error accessing media devices:", err)
        setStatus("Error: Could not access microphone")
      }
    }
    
    getAudioDevices()
    
    // Listen for device changes
    navigator.mediaDevices.addEventListener('devicechange', getAudioDevices)
    
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', getAudioDevices)
    }
  }, [])

  useEffect(() => {
    // Initialize WebSocket connection
    wsRef.current = new WebSocket('wss:////ai-voice-chat-zxsh.onrender.com/ws')
    
    wsRef.current.onopen = () => {
      console.log('WebSocket connected')
      setStatus('Connected to server')
    }
    
    wsRef.current.onmessage = async (event) => {
      const data = JSON.parse(event.data)
      
      if (data.type === 'transcription') {
        lastTranscriptRef.current = data.text
        setLiveTranscript(data.text)
      } else if (data.type === 'ai_response') {
        const finalTranscript = lastTranscriptRef.current || liveTranscript
        
        // Clear animation
        if (animationRef.current) {
          clearInterval(animationRef.current)
        }
        
        // First add the user's message
        setMessages(prev => [...prev, { type: 'user', text: finalTranscript }])
        
        // Then in a separate update, add the AI response
        setTimeout(() => {
          setMessages(prev => [...prev, { type: 'ai', text: data.text }])
          setLiveTranscript("")
          setDisplayedText("")
          lastTranscriptRef.current = ""
        }, 100)
        
        // Handle audio response
        const audioBlob = await fetch(`data:audio/mpeg;base64,${data.audio}`).then(r => r.blob())
        const url = URL.createObjectURL(audioBlob)
        setAiAudioUrl(url)
        setStatus("AI is speaking...")
        setIsAIPlaying(true)
        
        if (audioRef.current) {
          // If there's a previous play promise pending, wait for it
          if (playPromiseRef.current) {
            try {
              await playPromiseRef.current
            } catch (err) {
              console.error("Previous playback error:", err)
            }
          }
          
          // Stop any current playback
          audioRef.current.pause()
          audioRef.current.currentTime = 0
          
          // Set new source and play
          audioRef.current.src = url
          try {
            playPromiseRef.current = audioRef.current.play()
            await playPromiseRef.current
            playPromiseRef.current = null
          } catch (err) {
            console.error("Error auto-playing audio:", err)
            setStatus("Click to play AI response")
            setIsAIPlaying(false)
            playPromiseRef.current = null
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
    } else {
      // Properly shutdown VAD when not recording
      vad.pause()
      
      // Stop any active media tracks
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => {
          track.stop()
        })
        streamRef.current = null
      }
    }
  }, [recording])

  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight
    }
  }, [messages, liveTranscript])

  useEffect(() => {
    if (shouldClearTranscript) {
      setLiveTranscript("")
      setShouldClearTranscript(false)
    }
  }, [messages])

  // Use the VAD hook with WebSocket
  const vad = useMicVAD({
    onSpeechStart: () => {
      console.log("Voice started")
      setStatus("Voice detected...")
      if (silenceTimeoutRef.current) {
        clearTimeout(silenceTimeoutRef.current)
        silenceTimeoutRef.current = null
      }
    },
    onSpeechEnd: async (audioData) => {
      console.log("Voice stopped")
      if (recording && !isAIPlaying) {
        try {
          vad.pause() // Pause VAD immediately when speech ends
          setRecording(false) // Update UI to show we're not recording
          setStatus("Processing...")

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
              } else {
                console.error("WebSocket is not connected")
                setStatus("Error: Not connected to server")
                setRecording(true) // Re-enable recording on error
                vad.start()
              }
              resolve()
            }
            
            mediaRecorder.start()
            source.start()
            
            const duration = audioBuffer.length / audioBuffer.sampleRate * 1000
            setTimeout(() => {
              mediaRecorder.stop()
              source.stop()
              audioContext.close()
            }, duration + 100)
          })
        } catch (error) {
          console.error("Error processing audio:", error)
          setStatus("Error processing audio")
          setRecording(true) // Re-enable recording on error
          vad.start()
        }
      }
    },
    onVADMisfire: () => {
      // Handle VAD misfire if needed
    },
    positiveSpeechThreshold: 0.9,
    negativeSpeechThreshold: 0.8,
    minSpeechFrames: 5,
    preSpeechPadFrames: 2,
    redemptionFrames: 8,
    frameSamples: 1024
  })

  // Cleanup on component unmount
  useEffect(() => {
    return () => {
      // Ensure microphone is released when component unmounts
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => {
          track.stop()
        })
      }
      
      // Ensure VAD is completely destroyed
      vad.pause()
      cleanupAudio()
    }
  }, [])

  const cleanupAudio = () => {
    if (silenceTimeoutRef.current) {
      clearTimeout(silenceTimeoutRef.current)
      silenceTimeoutRef.current = null
    }

    // Completely stop and release the microphone stream
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => {
        if (track.readyState === 'live') {
          console.log('Stopping track:', track.label)
          track.stop()
        }
      })
      streamRef.current = null
    }

    // Ensure VAD is paused
    vad.pause()
    
    setRecording(false)
    recordingStartTimeRef.current = null
    setLiveTranscript("")
    currentChunkRef.current = []
  }

  // Create a completely new VAD instance each time we start recording
  const startRecording = async () => {
    if (isAIPlaying) return // Don't start if AI is playing
    console.log("Starting recording...", new Date().toISOString())
    try {
      // First ensure any previous recording is fully cleaned up
      cleanupAudio()
      
      setStatus("Listening...")
      currentChunkRef.current = []
      setLiveTranscript("")
      setInputMode('voice')

      // Get microphone access with selected device
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
          deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined
        } 
      })
      streamRef.current = stream
      
      setRecording(true)
      recordingStartTimeRef.current = Date.now()
      
      // Start VAD - constraints are handled at getUserMedia level
      await vad.start()
    } catch (error) {
      console.error("Error starting recording:", error)
      setStatus("Error: Could not access microphone")
      cleanupAudio()
    }
  }

  // Ensure we fully stop the recording when requested
  const stopRecording = (isManual: boolean = true) => {
    if (isManual) {
      // Only check duration for manual stops
      const recordingDuration = recordingStartTimeRef.current 
        ? Date.now() - recordingStartTimeRef.current 
        : 0

      if (recordingDuration < 5000) {
        setStatus("Recording too short")
        cleanupAudio()
        setTimeout(() => {
          setStatus("Idle")
        }, 2000)
        return
      }
    }

    setStatus("Processing...")
    
    // Ensure everything is fully shut down
    cleanupAudio()
  }

  const toggleRecording = () => {
    if (isAIPlaying) {
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current.currentTime = 0
      }
      setIsAIPlaying(false)
      setStatus("AI response stopped")
      startRecording() // Start recording when AI is stopped manually
    } else {
      if (recording) {
        stopRecording(true) // Manual stop
      } else {
        startRecording()
      }
    }
  }

  // Toggle device selector visibility
  const toggleDeviceSelector = () => {
    setShowDeviceSelector(prev => !prev)
  }

  // Handle device selection
  const handleDeviceChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newDeviceId = e.target.value
    setSelectedDeviceId(newDeviceId)
    
    // If already recording, restart with new device
    if (recording) {
      cleanupAudio()
      setTimeout(() => startRecording(), 500)
    }
  }

  useEffect(() => {
    if (!liveTranscript) {
      setDisplayedText("")
      return
    }

    let currentIndex = 0
    const words = liveTranscript.split(" ")
    
    // Clear any existing animation
    if (animationRef.current) {
      clearInterval(animationRef.current)
    }

    // Reset displayed text if it's a new transcription
    if (!liveTranscript.startsWith(displayedText)) {
      setDisplayedText("")
      currentIndex = 0
    }

    // Animate word by word
    animationRef.current = setInterval(() => {
      if (currentIndex <= words.length) {
        setDisplayedText(words.slice(0, currentIndex).join(" "))
        currentIndex++
      } else {
        if (animationRef.current) {
          clearInterval(animationRef.current)
        }
      }
    }, 200) // Adjust speed here (higher = slower)

    return () => {
      if (animationRef.current) {
        clearInterval(animationRef.current)
      }
    }
  }, [liveTranscript])

  const handleTextSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!textInput.trim() || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return

    const message = textInput.trim()
    setTextInput("")
    
    // Set input mode to text
    setInputMode('text')
    
    // Add user message to chat
    setMessages(prev => [...prev, { type: 'user', text: message }])
    
    // Send text message to server
    wsRef.current.send(JSON.stringify({
      type: 'text_message',
      text: message
    }))
    
    setStatus("Processing text message...")
  }

  return (
    <main className="bg-gray-900 min-h-screen flex flex-col items-center justify-center text-white relative">
      <div className="flex flex-col items-center justify-center w-full max-w-2xl mx-auto p-4 relative">
        <h1 className="text-2xl font-bold mb-8">AI Voice & Text Chat</h1>
        
        {/* Chat container */}
        <div 
          ref={chatContainerRef}
          className="w-full bg-gray-800 rounded-lg p-4 mb-4 h-[400px] overflow-y-auto flex flex-col gap-4"
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
                {displayedText}
              </div>
            </div>
          )}
        </div>
        
        {/* Text input form */}
        <form onSubmit={handleTextSubmit} className="w-full mb-4 flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            placeholder="Type your message..."
            className="flex-1 bg-gray-700 text-white px-4 py-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={isAIPlaying}
          />
          <button
            type="submit"
            disabled={!textInput.trim() || isAIPlaying}
            className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            <FaPaperPlane />
            Send
          </button>
        </form>
        
        {/* Controls */}
        <div className="w-full flex flex-col items-center gap-4">
          <div className="flex items-center gap-3">
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
            
            <button
              onClick={toggleDeviceSelector}
              className="bg-gray-700 hover:bg-gray-600 p-3 rounded-full text-lg"
              aria-label="Select microphone"
              title="Select microphone"
            >
              <FaCog />
            </button>
          </div>
          
          {/* Microphone selector dropdown */}
          {showDeviceSelector && (
            <div className="w-full bg-gray-800 p-3 rounded-lg mb-3">
              <label htmlFor="microphone-select" className="block mb-2 text-sm">
                Select Microphone:
              </label>
              <select
                id="microphone-select"
                value={selectedDeviceId}
                onChange={handleDeviceChange}
                className="w-full bg-gray-700 text-white px-3 py-2 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {audioDevices.map(device => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          
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
                playPromiseRef.current = null
                
                // Only auto-restart recording if previous input was voice
                if (inputMode === 'voice') {
                  startRecording()
                }
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
