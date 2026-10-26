const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const argon2 = require('argon2');

test('verified bookkeeper can read only the granted business and loses access on revoke', { skip: !process.env.FREEVOICES_TEST_API_URL, timeout: 30000 }, async t => {
  const { executeQuery:q, closePool } = require('../src/services/db.service');
  const ids = [];
  t.after(async () => {
    try {
      if (ids.length) {
        await q('DELETE FROM business_access_events WHERE owner_id IN (?) OR member_id IN (?)',[ids,ids]);
        await q('DELETE FROM business_bookkeepers WHERE owner_id IN (?) OR member_id IN (?)',[ids,ids]);
        await q('DELETE FROM documents WHERE user_id IN (?)',[ids]);
        await q('DELETE FROM customers WHERE user_id IN (?)',[ids]);
        await q('DELETE FROM sessions WHERE userId IN (?)',[ids]);
        await q('DELETE FROM users WHERE id IN (?)',[ids]);
      }
    } finally { await closePool(); }
  });
  const password = 'BookkeeperDemo!86';
  const hash = await argon2.hash(password);
  const createUser = async label => {
    const id = (await q('INSERT INTO users(email,password_hash,company_name,email_verified) VALUES(?,?,?,1)',[`${label}-${randomUUID()}@example.test`,hash,label])).insertId;
    ids.push(id);
    return id;
  };
  const ownerId = await createUser('owner');
  const memberId = await createUser('bookkeeper');
  const otherId = await createUser('other');
  const unverifiedId = await createUser('unverified');
  await q('UPDATE users SET email_verified=0 WHERE id=?',[unverifiedId]);
  const base = process.env.FREEVOICES_TEST_API_URL.replace(/\/$/,'');
  const ownerToken = randomUUID();
  const otherToken = randomUUID();
  for(const [id,token] of [[ownerId,ownerToken],[otherId,otherToken]])
    await q('INSERT INTO sessions(userId,token,expires) VALUES(?,?,DATE_ADD(NOW(),INTERVAL 1 HOUR))',[id,createHash('sha256').update(token).digest('hex')]);
  const request = async (token,route,method='GET',body) => {
    const response = await fetch(base+route,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  };
  const ownCustomer = await request(ownerToken,'/customers','POST',{name:'Owner buyer',email:'owner-buyer@example.test',billing_address:'Test road'});
  assert.equal(ownCustomer.status,201);
  const otherCustomer = await request(otherToken,'/customers','POST',{name:'Other buyer',email:'other-buyer@example.test',billing_address:'Test road'});
  assert.equal(otherCustomer.status,201);
  const memberEmail = (await q('SELECT email FROM users WHERE id=?',[memberId]))[0].email;
  const unverifiedEmail = (await q('SELECT email FROM users WHERE id=?',[unverifiedId]))[0].email;
  assert.equal((await request(ownerToken,'/business/bookkeepers','POST',{email:unverifiedEmail,password})).status,422);
  assert.equal((await request(ownerToken,'/business/bookkeepers','POST',{email:memberEmail,password:'wrong'})).status,401);
  const grant = await request(ownerToken,'/business/bookkeepers','POST',{email:memberEmail,password});
  assert.equal(grant.status,201,JSON.stringify(grant.data));
  const login = await fetch(base+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:memberEmail,password})});
  assert.equal(login.status,200);
  const signedIn = await login.json();
  assert.equal(signedIn.user.role,'BOOKKEEPER');
  assert.equal((await request(signedIn.token,'/business/access')).data.business_id,ownerId);
  const customers = await request(signedIn.token,'/customers');
  assert.equal(customers.status,200);
  assert.deepEqual(customers.data.data.map(row=>row.id),[ownCustomer.data.id]);
  assert.equal((await request(signedIn.token,`/customers/${otherCustomer.data.id}`)).status,404);
  assert.equal((await request(signedIn.token,'/customers','POST',{name:'Denied',email:'denied@example.test',billing_address:'Test'})).status,403);
  assert.equal((await request(signedIn.token,'/settings')).status,403);
  assert.equal((await request(signedIn.token,'/account/export')).status,403);
  const list = await request(ownerToken,'/business/bookkeepers');
  assert.equal(list.data.length,1);
  assert.equal((await request(ownerToken,`/business/bookkeepers/${list.data[0].id}`,'DELETE',{password:'wrong'})).status,401);
  assert.equal((await request(signedIn.token,'/customers')).status,200);
  const revoke = await request(ownerToken,`/business/bookkeepers/${list.data[0].id}`,'DELETE',{password});
  assert.equal(revoke.status,200,JSON.stringify(revoke.data));
  assert.equal((await request(signedIn.token,'/customers')).status,401);
  const events = await q('SELECT action FROM business_access_events WHERE owner_id=? ORDER BY id',[ownerId]);
  assert.deepEqual(events.map(row=>row.action),['GRANTED','REVOKED']);
});
