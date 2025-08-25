# backend-python/main.py
from fastapi import FastAPI
import numpy as np

app = FastAPI()

@app.post("/matrix-multiply")
def matrix_multiply(data: dict):
    A = np.array(data["A"])
    B = np.array(data["B"])
    return {"result": np.dot(A, B).tolist()}