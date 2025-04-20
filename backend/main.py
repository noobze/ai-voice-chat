import io
import os
import json
import base64
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket
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

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            # Receive the audio data
            audio_data = await websocket.receive_bytes()
            
            try:
                # Convert bytes to file-like object
                audio_file = io.BytesIO(audio_data)
                audio_file.name = "audio.webm"
                
                # 1. Transcribe audio using Whisper
                transcript = client.audio.transcriptions.create(
                    model="whisper-1",
                    file=audio_file,
                    response_format="text"
                )
                
                print(f"Transcription: {transcript}")
                
                # Send transcription back immediately
                await websocket.send_json({
                    "type": "transcription",
                    "text": transcript
                })
                
                # 2. Get chat response
                chat_response = client.chat.completions.create(
                    model="gpt-3.5-turbo",
                    messages=[{"role": "user", "content": transcript}]
                )
                
                ai_text = chat_response.choices[0].message.content
                print(f"AI response: {ai_text}")
                
                # 3. Generate speech from AI response
                tts_response = client.audio.speech.create(
                    model="tts-1",
                    voice="alloy",
                    input=ai_text
                )
                
                # Convert audio to base64
                audio_base64 = base64.b64encode(tts_response.content).decode('utf-8')
                
                # 4. Send AI response and audio back
                await websocket.send_json({
                    "type": "ai_response",
                    "text": ai_text,
                    "audio": audio_base64
                })
                
            except Exception as e:
                print(f"Error processing audio: {str(e)}")
                await websocket.send_json({
                    "type": "error",
                    "message": str(e)
                })
                
    except Exception as e:
        print(f"WebSocket error: {str(e)}")

@app.get("/health")
async def health_check():
    return {"status": "ok"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
