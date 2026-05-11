import { EventEmitter } from 'events';

// In-process pub/sub for SSE sync progress. Channel key: "sync:<connectionId>"
const syncEventBus = new EventEmitter();
syncEventBus.setMaxListeners(200);

export default syncEventBus;
