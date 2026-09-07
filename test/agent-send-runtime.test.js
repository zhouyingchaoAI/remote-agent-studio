const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { AgentSession } = require('../electron/ssh/AgentSession');

test('send starts watchdog, processes GPT-6 output and completes without ReferenceError', async () => {
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  const session = new AgentSession({ execStream: async () => {
    setImmediate(() => {
      stream.emit('data', Buffer.from(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'GPT6_OK'}})+'\n'));
      stream.emit('close', 0);
    });
    return stream;
  } }, null, { agent:'codex',model:'gpt-6-astra' });
  const messages=[];
  session.on('message',m=>messages.push(m));
  await session.send('Reply GPT6_OK');
  assert.ok(messages.some(m=>m.text==='GPT6_OK'));
  assert.equal(session.running,false);
  assert.equal(session.stream,null);
});
