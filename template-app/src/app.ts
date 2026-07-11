import { createApp } from '@zyno-io/ts-server-foundation';

import { AppConfig } from './config';
import { ExampleController } from './controllers/Example.controller';
import { DB } from './database';
import { ExampleService } from './services/Example.service';

export const app = createApp({
    config: AppConfig,
    db: DB,
    controllers: [ExampleController],
    providers: [ExampleService]
});
