import type { ClassType } from '../types';

export interface CommandMetadata {
    name: string;
    description?: string;
}

export interface CommandControllerOptions {
    description?: string;
}

export type CommandOptions = CommandControllerOptions;

export interface Command {
    execute(...args: unknown[]): unknown;
}

const commandMetadata = new WeakMap<ClassType, CommandMetadata>();

function command(name: string, options: CommandOptions = {}): ClassDecorator {
    return target => {
        commandMetadata.set(target as unknown as ClassType, { name, description: options.description });
    };
}

const controller = command;

export const cli = { command, controller };

export function getCommandMetadata(commandClass: ClassType): CommandMetadata | undefined {
    return commandMetadata.get(commandClass);
}
