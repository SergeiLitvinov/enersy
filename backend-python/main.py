# backend-python/main.py
from fastapi import FastAPI
import numpy as np

app = FastAPI()

@app.post("/matrix-multiply")
def matrix_multiply(data: dict):
    try:
        A = np.array(data["A"])
        B = np.array(data["B"])
        result = np.dot(A, B)
        return {"result": result.tolist()}
    except Exception as e:
        return {"error": f"Matrix multiplication failed: {str(e)}"}