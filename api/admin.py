"""Administration access check, independent of domain operations."""

from fastapi import APIRouter, Depends

from api.auth import require_permissions

router = APIRouter(prefix="/api/admin", tags=["admin"])


@router.get("/me")
def me(claims: dict = Depends(require_permissions("read:admin"))):
    return {"sub": claims["sub"], "permissions": claims["permissions"]}
