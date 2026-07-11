export class HttpError extends Error {
    constructor(
        readonly httpCode: number,
        message: string
    ) {
        super(message);
        this.name = new.target.name;
    }
}

export class HttpBadRequestError extends HttpError {
    constructor(message = 'Bad Request') {
        super(400, message);
    }
}

export class HttpUnauthorizedError extends HttpError {
    constructor(message = 'Unauthorized') {
        super(401, message);
    }
}

export class HttpAccessDeniedError extends HttpError {
    constructor(message = 'Access Denied') {
        super(403, message);
    }
}

export class HttpNotFoundError extends HttpError {
    constructor(message = 'Not Found') {
        super(404, message);
    }
}

export class HttpGoneError extends HttpError {
    constructor(message = 'Gone') {
        super(410, message);
    }
}

export class HttpConflictError extends HttpError {
    constructor(message = 'Conflict') {
        super(409, message);
    }
}

export class HttpPayloadTooLargeError extends HttpError {
    constructor(message = 'Payload Too Large') {
        super(413, message);
    }
}

export class HttpUnsupportedMediaTypeError extends HttpError {
    constructor(message = 'Unsupported Media Type') {
        super(415, message);
    }
}

export class HttpTooManyRequestsError extends HttpError {
    constructor(message = 'Too Many Requests') {
        super(429, message);
    }
}

export class HttpInternalServerError extends HttpError {
    constructor(message = 'Internal Server Error') {
        super(500, message);
    }
}

export class HttpUserError extends HttpError {
    constructor(message = 'HTTP Error') {
        super(422, message);
    }
}

export function createHttpError(httpCode: number, defaultMessage = defaultHttpMessage(httpCode)) {
    return class extends HttpError {
        constructor(message = defaultMessage) {
            super(httpCode, message);
        }
    };
}

function defaultHttpMessage(httpCode: number): string {
    if (httpCode === 400) return 'Bad Request';
    if (httpCode === 401) return 'Unauthorized';
    if (httpCode === 403) return 'Access Denied';
    if (httpCode === 404) return 'Not Found';
    if (httpCode === 409) return 'Conflict';
    if (httpCode === 410) return 'Gone';
    if (httpCode === 413) return 'Payload Too Large';
    if (httpCode === 415) return 'Unsupported Media Type';
    if (httpCode === 429) return 'Too Many Requests';
    if (httpCode === 500) return 'Internal Server Error';
    return 'HTTP Error';
}
