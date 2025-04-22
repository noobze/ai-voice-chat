from typing import List, Dict, Any
from langchain.agents import Tool, AgentExecutor, LLMSingleActionAgent
from langchain.memory import ConversationBufferMemory
from langchain.prompts import MessagesPlaceholder
from langchain.schema import SystemMessage, AIMessage, HumanMessage
from langchain_community.chat_message_histories import RedisChatMessageHistory
from langchain.chains import LLMChain
from langchain_core.prompts import ChatPromptTemplate
from langchain_groq import ChatGroq
from instructions import *
import os 
import json
import logging
import asyncio
from typing import AsyncIterator, Optional

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

os.environ["GROQ_API_KEY"]= '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'

class AgentWithMemory:
    def __init__(self, name: str, instructions: str, student_profile: Dict = None, llm=None):
        logger.info(f"Initializing {name} with student profile")
        self.name = name
        self.llm = llm if llm is not None else ChatGroq(
            model_name="llama-3.3-70b-versatile",
            temperature=0.7,
            streaming=True
        )
        
        self.memory = ConversationBufferMemory(
            memory_key="chat_history",
            return_messages=True
        )
        
        # Include student profile in instructions
        student_context = self._format_student_context(student_profile) if student_profile else ""
        self.instructions = f"{instructions}\n\nStudent Context:\n{student_context}"
        logger.info(f"Agent {name} initialized with student context")

    def _format_student_context(self, student_profile: Dict) -> str:
        if not student_profile:
            return ""
        
        logger.info("Formatting student context for agent instructions")
        context_parts = []
        for key, value in student_profile.items():
            if value:
                formatted_key = key.replace('_', ' ').title()
                if isinstance(value, list):
                    context_parts.append(f"- {formatted_key}: {', '.join(value)}")
                else:
                    context_parts.append(f"- {formatted_key}: {value}")
        return "\n".join(context_parts)

    async def run(self, input_text: str) -> AsyncIterator[str]:
        """Process the user input and return response as a stream"""
        logger.info(f"{self.name} processing input: {input_text[:50]}...")
        
        prompt = ChatPromptTemplate.from_messages([
            ("system", self.instructions),
            *[(msg.type, msg.content) for msg in self.memory.chat_memory.messages],
            ("human", input_text)
        ])
        
        chain = prompt | self.llm
        
        # Store the complete response for memory
        complete_response = ""
        
        logger.info(f"{self.name} generating response...")
        async for chunk in chain.astream({"input": input_text}):
            complete_response += chunk.content
            yield chunk.content
        
        # Add messages to memory after complete response
        self.memory.chat_memory.add_user_message(input_text)
        self.memory.chat_memory.add_ai_message(complete_response)
        
        logger.info(f"{self.name} completed response generation")

class OrchestratorAgent:
    def __init__(self, student_profile: Dict = None):
        logger.info("Initializing OrchestratorAgent")
        self.llm = ChatGroq(
            model_name="llama-3.3-70b-versatile",
            temperature=0.7,
            streaming=True
        )
        
        self.student_profile = student_profile or {}
        logger.info(f"Student profile loaded: {json.dumps(self.student_profile, indent=2)}")
        
        # Define agent descriptions
        self.agent_descriptions = {
            "motivation": {
                "name": "Motivation Agent",
                "description": """
                1. Specializes in providing emotional support and encouragement
                2. Helps students maintain focus and overcome learning challenges
                3. Offers personalized motivation strategies and positive reinforcement
                """
            },
            "maths_science": {
                "name": "Maths and Science Tutor Agent",
                "description": """
                1. Expert in mathematics, physics, chemistry, and biology concepts
                2. Provides step-by-step problem-solving guidance
                3. Uses practical examples and visual explanations
                """
            },
            "language_social": {
                "name": "Language and Social Studies Agent",
                "description": """
                1. Specializes in language arts, history, and social sciences
                2. Helps with writing, grammar, and literary analysis
                3. Provides cultural context and historical perspectives
                """
            }
        }
        
        logger.info("Initializing sub-agents with student profile")
        # Initialize sub-agents with student profile
        self.motivation_agent = AgentWithMemory(
            name=self.agent_descriptions["motivation"]["name"],
            instructions=motivation_agent_instructor,
            student_profile=student_profile,
            llm=self.llm
        )
        
        self.maths_science_agent = AgentWithMemory(
            name=self.agent_descriptions["maths_science"]["name"],
            instructions=maths_science_tutor_agent_instructor,
            student_profile=student_profile,
            llm=self.llm
        )
        
        self.language_social_agent = AgentWithMemory(
            name=self.agent_descriptions["language_social"]["name"],
            instructions=language_social_studies_agent_instructor,
            student_profile=student_profile,
            llm=self.llm
        )

        self.memory = ConversationBufferMemory(
            memory_key="chat_history",
            return_messages=True
        )
        
        # Updated selection prompt to include student context
        self.selection_prompt = """You are an agent selector. Your task is to analyze the user's input and select the most appropriate agent to handle their query.

            Student Profile:
            {student_context}

            Available agents and their capabilities:
            {agent_descriptions}

            User Query: {query}
            Chat History: {history}

            IMPORTANT: You must respond with a valid JSON object containing exactly these fields:
            {
                "selected_agent": "motivation" | "maths_science" | "language_social",
                "reason": "your reason for selection"
            }

            Consider the student's profile, academic level, and learning style when selecting the most appropriate agent."""

        self.current_agent = None
        logger.info("OrchestratorAgent initialization complete")

    async def select_agent(self, user_input: str) -> AgentWithMemory:
        """Select the appropriate agent based on the user's input using AI"""
        logger.info("Starting agent selection process")
        try:
            agent_desc_text = "\n\n".join([
                f"{desc['name']}:\n{desc['description']}"
                for desc in self.agent_descriptions.values()
            ])
            
            # Format student context
            student_context = "\n".join([
                f"{key.replace('_', ' ').title()}: {value}"
                for key, value in self.student_profile.items()
                if value
            ]) if self.student_profile else "No student profile available"
            
            history = "\n".join([
                f"{'User' if i%2==0 else 'Assistant'}: {msg.content}"
                for i, msg in enumerate(self.memory.chat_memory.messages[-4:])
            ]) if self.memory.chat_memory.messages else "No previous context"
            
            # Create a non-streaming version of LLM for agent selection
            selection_llm = ChatGroq(
                model_name="llama-3.3-70b-versatile",
                temperature=0.3,  # Lower temperature for more consistent selection
                streaming=False
            )
            
            # Simplified and more structured selection prompt
            selection_prompt = """You are an agent selector. Analyze the user's input and select the most appropriate agent.

                Available agents:
                1. motivation - For emotional support, encouragement, and motivation
                2. maths_science - For mathematics, physics, chemistry, and biology
                3. language_social - For language arts, history, and social sciences

                User Query: {query}
                Previous Context: {history}
                Student Profile: {student_context}

                Respond with ONLY a JSON object in this exact format:
                {{"selected_agent": "motivation"|"maths_science"|"language_social", "reason": "brief reason for selection"}}

                Example response:
                {{"selected_agent": "maths_science", "reason": "Query is about mathematics concepts"}}"""
            
            # Format the prompt with all variables
            formatted_prompt = selection_prompt.format(
                query=user_input,
                history=history,
                student_context=student_context
            )
            
            messages = [
                {"role": "system", "content": formatted_prompt},
                {"role": "user", "content": user_input}
            ]
            
            logger.info("Getting agent selection from LLM")
            response = await selection_llm.ainvoke(messages)
            
            # Clean and parse response
            cleaned_response = response.content.strip()
            logger.info(f"Raw selection response: {cleaned_response}")
            
            try:
                selection = json.loads(cleaned_response)
                if not isinstance(selection, dict) or 'selected_agent' not in selection:
                    raise ValueError("Invalid response format")
                
                selected_agent = selection['selected_agent']
                if selected_agent not in self.agent_descriptions:
                    raise ValueError(f"Invalid agent type: {selected_agent}")
                
                logger.info(f"Successfully selected agent: {selected_agent}")
                logger.info(f"Selection reason: {selection.get('reason', 'No reason provided')}")
                
                agent_map = {
                    "motivation": self.motivation_agent,
                    "maths_science": self.maths_science_agent,
                    "language_social": self.language_social_agent,
                }
                
                self.current_agent = agent_map[selected_agent]
                
                # Add selection to memory
                self.memory.chat_memory.add_user_message(user_input)
                self.memory.chat_memory.add_ai_message(
                    f"Selected {self.current_agent.name}: {selection.get('reason', 'No reason provided')}"
                )
                
                return self.current_agent
                
            except json.JSONDecodeError as e:
                logger.error(f"Failed to parse JSON response: {str(e)}")
                raise ValueError("Invalid JSON response from agent selector")
            
        except Exception as e:
            logger.error(f"Error in agent selection: {str(e)}")
            logger.info("Falling back to motivation agent")
            self.current_agent = self.motivation_agent
            return self.current_agent

    async def process_query(self, user_input: str) -> AsyncIterator[str]:
        """Process the user query and return response stream"""
        logger.info("Processing user query")
        selected_agent = await self.select_agent(user_input)
        logger.info(f"Getting response from {selected_agent.name}")
        async for chunk in selected_agent.run(user_input):
            yield chunk
        logger.info("Query processing complete")

async def process_user_query(user_input: str) -> AsyncIterator[str]:
    """Main function to process user queries"""
    orchestrator = OrchestratorAgent()
    async for chunk in orchestrator.process_query(user_input):
        yield chunk

async def main():
    while True:
        try:
            user_query = input("\nEnter your query (or 'exit' to quit): ")
            if user_query.lower() in ['exit', 'quit', 'bye']:
                print("Goodbye!")
                break
                
            print("\nProcessing...")
            async for chunk in process_user_query(user_query):
                print(chunk, end="", flush=True)
            print("\n")
            
        except KeyboardInterrupt:
            print("\nExiting...")
            break
        except Exception as e:
            print(f"\nError: {str(e)}")

if __name__ == "__main__":
    asyncio.run(main()) 