import test from 'node:test'
import assert from 'node:assert/strict'
import peopleMod from '../bot_impl/ai-chat/people.js'

const { createPeopleService } = peopleMod

function makeStore (initial = {}) {
  let saved = null
  let saveCalls = 0
  return {
    store: {
      load: () => initial,
      save: (data) => {
        saveCalls += 1
        saved = JSON.parse(JSON.stringify(data))
      }
    },
    getSaved: () => saved,
    getSaveCalls: () => saveCalls
  }
}

test('people.setProfile overwrites and persists by username key', async () => {
  const state = {}
  const { store, getSaved, getSaveCalls } = makeStore({ profiles: {}, commitments: [] })
  const people = createPeopleService({ state, peopleStore: store, now: () => 123 })

  const res = people.setProfile({ player: 'Alice', profile: '叫我   阿猫  ', source: 'test' })
  assert.equal(res.ok, true)
  assert.equal(res.key, 'Alice')
  assert.equal(state.aiPeople.profiles.Alice.profile, '叫我 阿猫')
  assert.equal(getSaveCalls(), 1)
  assert.deepEqual(Object.keys(getSaved().profiles), ['Alice'])
})

test('people.upsertCommitment de-dupes by (player, action) and persists updates', async () => {
  const state = {}
  const { store, getSaveCalls } = makeStore({ profiles: {}, commitments: [] })
  const people = createPeopleService({ state, peopleStore: store, now: () => 1000 })

  const a = people.upsertCommitment({ player: 'Alice', action: '帮我找钻石', source: 'test' })
  const b = people.upsertCommitment({ player: 'Alice', action: '帮我找钻石', status: 'done', source: 'test2' })

  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(a.id, b.id)

  const list = people.listCommitments()
  assert.equal(list.length, 1)
  assert.equal(list[0].status, 'done')
  assert.equal(getSaveCalls(), 2)
})

test('people.applyPatch persists once for batched updates', async () => {
  const state = {}
  const { store, getSaveCalls } = makeStore({ profiles: {}, commitments: [] })
  const people = createPeopleService({ state, peopleStore: store, now: () => 2000 })

  const res = people.applyPatch({
    profiles: [{ player: 'Bob', profile: '称呼：老鲍' }],
    commitments: [{ player: 'Bob', action: '明天带你回家', status: 'pending' }],
    source: 'inspector'
  })

  assert.equal(res.ok, true)
  assert.equal(res.changed, true)
  assert.equal(getSaveCalls(), 1)
})

test('people.buildAllProfilesContext only includes non-empty profiles', async () => {
  const state = {}
  const { store } = makeStore({ profiles: {}, commitments: [] })
  const people = createPeopleService({ state, peopleStore: store, now: () => 1 })

  people.setProfile({ player: 'Alice', profile: '', source: 'test' })
  people.setProfile({ player: 'Bob', profile: '喜欢被叫鲍勃', source: 'test' })

  const ctx = people.buildAllProfilesContext()
  assert.match(ctx, /<people>/)
  assert.doesNotMatch(ctx, /Alice/)
  assert.match(ctx, /<profile n="Bob">喜欢被叫鲍勃<\/profile>/)
})

test('people.resolveCommitment updates status and hides from pending context', async () => {
  const state = {}
  const { store } = makeStore({ profiles: {}, commitments: [] })
  const people = createPeopleService({ state, peopleStore: store, now: () => 1 })

  people.upsertCommitment({ player: 'Alice', action: '帮我建房子', status: 'pending', source: 'test' })
  assert.match(people.buildAllCommitmentsContext(), /Alice：帮我建房子/)

  const res = people.resolveCommitment({ player: 'Alice', action: '帮我建房子', status: 'done', source: 'test2' })
  assert.equal(res.ok, true)
  assert.doesNotMatch(people.buildAllCommitmentsContext(), /帮我建房子/)
})

test('people.resolveCommitment can resolve latest pending when action omitted', async () => {
  const state = {}
  const { store } = makeStore({ profiles: {}, commitments: [] })
  let t = 1000
  const now = () => { t += 1; return t }
  const people = createPeopleService({ state, peopleStore: store, now })

  people.upsertCommitment({ player: 'Bob', action: '第一件事', status: 'pending', source: 'test' })
  people.upsertCommitment({ player: 'Bob', action: '第二件事', status: 'pending', source: 'test' })

  const res = people.resolveCommitment({ player: 'Bob', status: 'failed', source: 'test2' })
  assert.equal(res.ok, true)

  const ctx = people.buildAllCommitmentsContext()
  assert.match(ctx, /Bob：第一件事/)
  assert.doesNotMatch(ctx, /Bob：第二件事/)
})
