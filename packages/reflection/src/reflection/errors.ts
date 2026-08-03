export class ValidatorError extends Error {
    readonly errors: ValidatorError[];

    constructor(
        public readonly code: string,
        message: string,
        public readonly path: string = ''
    ) {
        super(message);
        this.errors = [this];
    }
}

// Consumers (including structured loggers) use the error constructor name as
// part of their public output. Keep it stable when a browser bundle minifies
// this class.
Object.defineProperty(ValidatorError, 'name', { configurable: true, value: 'ValidatorError' });

export { ValidatorError as ValidationError };
