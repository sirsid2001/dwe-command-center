"""
Modal App Template
This is a template showing how to build API endpoints for n8n workflows.
"""

import modal
from fastapi import Header, HTTPException

app = modal.App("my-workflow")

# Define your dependencies here
image = modal.Image.debian_slim().pip_install("anthropic", "fastapi")


@app.function(
    image=image,
    secrets=[
        modal.Secret.from_name("anthropic-api-key"),
        modal.Secret.from_name("api-auth-token")
    ],
    timeout=120,
)
@modal.fastapi_endpoint(method="POST")
def process_request(data: dict, authorization: str = Header(None)) -> dict:
    """
    Example endpoint that uses Claude AI to process requests.

    Input: {"prompt": "Your question here"}
    Output: {"response": "AI generated response"}
    """
    import anthropic
    import os

    # Bearer token authentication
    expected_token = os.environ.get("API_AUTH_TOKEN")
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=401,
            detail="Missing or invalid authorization header"
        )

    token = authorization.replace("Bearer ", "")
    if token != expected_token:
        raise HTTPException(
            status_code=403,
            detail="Invalid authentication token"
        )

    # Validate input
    prompt = data.get("prompt")
    if not prompt:
        raise HTTPException(
            status_code=400,
            detail="Missing 'prompt' in request body"
        )

    # Call Claude API
    client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])

    message = client.messages.create(
        model="claude-opus-4-5-20251101",
        max_tokens=1024,
        messages=[{"role": "user", "content": prompt}],
        system="You are a helpful assistant."
    )

    return {"response": message.content[0].text}


# Add more endpoints here as needed
# @app.function(...)
# @modal.fastapi_endpoint(method="POST")
# def another_endpoint(data: dict, authorization: str = Header(None)) -> dict:
#     ...
