import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { loadCatalog, searchBoards } from '../src/boards.js';

const catalog = loadCatalog();
const snake = /^[a-z0-9]+(_[a-z0-9]+)*$/;

test('ships with the two default boards from beitdin.dev', () => {
  assert.deepEqual([...catalog.keys()].sort(), ['architecture', 'product']);
});

test('every board meets the catalog rules', () => {
  for (const b of catalog.values()) {
    assert.match(b.id, snake);
    assert.match(b.name, /_board$/);
    assert.ok(b.description.length > 0, b.id);
    assert.ok(b.tags.length > 0, b.id);
    assert.equal(new Set(b.roles.map(r => r.title)).size, 3, b.id);
    for (const r of b.roles) {
      assert.match(r.title, snake);
      assert.ok(r.focus.length > 20, `${b.id}/${r.title}`);
    }
  }
});

test('the two boards from the web app are unchanged', () => {
  assert.deepEqual(catalog.get('architecture').roles.map(r => [r.title, r.focus]), [
    ['technical_architect', 'Focus on scalability, architecture patterns and system structure. Do not design UI or UX.'],
    ['security_expert', 'Focus on security, attack vectors and data protection. Do not design features.'],
    ['functional_architect', 'Focus on business logic, functional requirements and mapping user needs to system capabilities.']
  ]);
  assert.deepEqual(catalog.get('product').roles.map(r => [r.title, r.focus]), [
    ['product_manager', 'Focus on user value, business goals and feature prioritization.'],
    ['ux_designer', 'Focus on user experience, accessibility and interface flow.'],
    ['tech_lead', 'Focus on feasibility, technical debt and development speed.']
  ]);
});

test('board files contain no em dash', () => {
  const dir = new URL('../boards/', import.meta.url);
  for (const f of readdirSync(dir)) {
    assert.ok(!readFileSync(new URL(f, dir), 'utf8').includes(String.fromCharCode(0x2014)), f);
  }
});

test('search requires every word and honours the category', () => {
  assert.equal(searchBoards(catalog, { query: 'system security' }).length, 1);
  assert.equal(searchBoards(catalog, { query: 'zzz-not-a-word' }).length, 0);
  assert.ok(searchBoards(catalog, { category: 'product' }).every(b => b.category === 'product'));
});
