class AppError(Exception):
    def __init__(self, code: str, message: str, status: int = 422, details=None, headers=None):
        self.code, self.message, self.status = code, message, status
        self.details = details or []
        self.headers = headers or {}


class LeaseLost(Exception):
    pass
