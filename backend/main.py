import io
import os
from dotenv import load_dotenv
from fastapi import FastAPI, UploadFile, File
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from openai import OpenAI

# Load environment variables from .env file
load_dotenv()

client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

app = FastAPI()

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

async def stream_audio(audio_bytes):
    try:
        # 1. Transcribe audio to text
        audio_file = io.BytesIO(audio_bytes)
        audio_file.name = "audio.webm"  # Name is required for content type detection
        
        transcript = client.audio.transcriptions.create(
            model="whisper-1",
            file=audio_file,
            response_format="text"
        )
        
        prompt = transcript
        print(f"Transcription: {prompt}")
        
        # 2. Get chat response
        chat_response = client.chat.completions.create(
            model="gpt-3.5-turbo",
            messages=[{"role": "user", "content": prompt}]
        )
        
        ai_text = chat_response.choices[0].message.content
        print(f"AI response: {ai_text}")
        
        # 3. Synthesize speech (TTS)
        tts_response = client.audio.speech.create(
            model="tts-1",
            voice="alloy",  # Options: alloy, echo, fable, onyx, nova, shimmer
            input=ai_text
        )
        
        # 4. Stream the audio back
        def audio_stream():
            for chunk in tts_response.iter_bytes(chunk_size=4096):
                yield chunk
        
        return StreamingResponse(audio_stream(), media_type="audio/mpeg")
    
    except Exception as e:
        print(f"Error in stream_audio: {str(e)}")
        raise

@app.post("/voice-chat")
async def voice_chat(audio: UploadFile = File(...)):
    try:
        print(f"Received audio file: {audio.filename}")
        audio_bytes = await audio.read()
        return await stream_audio(audio_bytes)
    except Exception as e:
        print(f"Error in voice_chat: {str(e)}")
        raise

@app.get("/health")
async def health_check():
    return {"status": "ok"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
