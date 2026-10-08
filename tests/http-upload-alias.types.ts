import { FileUpload } from '../src';

export type ImportedImageUpload = FileUpload<{
    maxSize: '128B';
    allowedTypes: ['image/png'];
}>;

export type GenericImageUpload<Types extends string[]> = FileUpload<{
    maxSize: '128B';
    allowedTypes: Types;
}>;
