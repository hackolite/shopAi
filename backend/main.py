from __future__ import annotations

import os

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from api.cad_projects import router as cad_router
from api.furniture_library import router as furniture_library_router
from api.platform import router as platform_router
from api.projects import router as projects_router
from services.demo_initializer import init_retail_cad_demo
from services import platform_service

app = FastAPI(
    title="Retail Digital Twin API",
    version="1.0.0",
    description="Backend API for the Retail Digital Twin MVP",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

init_retail_cad_demo()
platform_service.ensure_platform_schema()

app.include_router(projects_router)
app.include_router(cad_router)
app.include_router(furniture_library_router)
app.include_router(platform_router)

_icons_path = os.path.join(os.path.dirname(__file__), "storage", "icons")
if os.path.isdir(_icons_path):
    app.mount("/icons", StaticFiles(directory=_icons_path), name="icons")


@app.middleware("http")
async def attach_current_user(request: Request, call_next):
    user = platform_service.resolve_session_user(request)
    if platform_service._request_uses_forwarded_session(request) and user is None:
        return JSONResponse(status_code=401, content={"detail": "Invalid forwarded agent session"})
    token = platform_service.set_current_user(user)
    try:
        return await call_next(request)
    finally:
        platform_service.reset_current_user(token)


@app.get("/")
def health():
    return {"status": "ok", "service": "Retail Digital Twin API"}
