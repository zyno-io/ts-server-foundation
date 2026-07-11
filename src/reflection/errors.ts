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

export { ValidatorError as ValidationError };
