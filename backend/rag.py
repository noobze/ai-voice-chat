from qdrant_client import QdrantClient

# Replace with your Qdrant server details and credentials
url = "yhttps://c6fd972a-3f78-4874-9a48-125d4b2aa249.us-east4-0.gcp.cloud.qdrant.iol"
port = 6333  # Default Qdrant port
#api_key = "your_api_key"

# Initialize the Qdrant client with API key authentication
client = QdrantClient(url=url, port=port)#, api_key=api_key)

# Get the list of collections
collections = client.get_collections().collections

# Print the collection names
print("List of Qdrant collections:")
for collection in collections:
    print(f"- {collection.name}")