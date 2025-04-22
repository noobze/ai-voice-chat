import io
import os
import json
import base64
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from openai import OpenAI
from agents import process_user_query
# Load environment variables from .env file
load_dotenv()

client = OpenAI(api_key="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")

app = FastAPI()

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

async def process_audio_message(audio_data: bytes, websocket: WebSocket):
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
        
        await process_text_message(transcript, websocket)
        
    except Exception as e:
        print(f"Error processing audio: {str(e)}")
        await websocket.send_json({
            "type": "error",
            "message": str(e)
        })

async def process_text_message(text: str, websocket: WebSocket):
    try:
        # Get chat response
        chat_response = client.chat.completions.create(
            model="gpt-3.5-turbo",
            messages=[{"role": "user", "content": text}]
        )
        
        ai_text = chat_response.choices[0].message.content
        #print(f"AI response: {ai_text}")
        from non_stream_agent import process_user_query
        print(process_user_query)
        ai_text  = process_user_query(ai_text)
        ai_text = chat_response.choices[0].message.content

        # Generate speech from AI response
        tts_response = client.audio.speech.create(
            model="tts-1",
            voice="alloy",
            input=ai_text
        )
        
        # Convert audio to base64
        audio_base64 = base64.b64encode(tts_response.content).decode('utf-8')
        
        # Send AI response and audio back
        await websocket.send_json({
            "type": "ai_response",
            "text": ai_text,
            "audio": audio_base64
        })
        
    except Exception as e:
        print(f"Error processing text: {str(e)}")
        await websocket.send_json({
            "type": "error",
            "message": str(e)
        })

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            # Receive data from client
            data = await websocket.receive()
            
            if "bytes" in data:
                # Handle audio data
                await process_audio_message(data["bytes"], websocket)
            elif "text" in data:
                # Handle text message
                message = json.loads(data["text"])
                if message["type"] == "text_message":
                    await process_text_message(message["text"], websocket)
                
    except Exception as e:
        print(f"WebSocket error: {str(e)}")

@app.get("/health")
async def health_check():
    return {"status": "ok"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
