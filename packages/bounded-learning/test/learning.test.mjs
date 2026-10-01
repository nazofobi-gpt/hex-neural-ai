import test from "node:test";import assert from "node:assert/strict";import{BoundedLearner}from"../dist/index.js";
const ev=(signal,scope="PROJECT",scopeId="p1",action="routeA")=>({signal,scope,scopeId,action,ts:1});
test("bounded explainable updates and runaway guard",()=>{const l=new BoundedLearner("g1",7);for(let i=0;i<100;i++)l.observe(ev("positive"));assert.ok(l.score("PROJECT","p1","routeA")<=1);const r=l.observe(ev("negative"));assert.equal(r.reward,-1);});
test("scope isolation",()=>{const l=new BoundedLearner("g1",7);l.observe(ev("positive","PROJECT","p1"));assert.equal(l.score("PROJECT","p2","routeA"),0);assert.equal(l.score("USER","p1","routeA"),0);});
test("checkpoint rollback and reset/forget",()=>{const l=new BoundedLearner("g1",7);l.observe(ev("positive"));const c=l.checkpoint();l.observe(ev("negative"));l.restore(c);assert.equal(l.checkpoint().weights["PROJECT:p1:routeA"],c.weights["PROJECT:p1:routeA"]);l.forget("PROJECT","p1");assert.equal(l.score("PROJECT","p1","routeA"),0);});
test("checkpoint is tied to graph/version seed",()=>{const l=new BoundedLearner("g1",7);assert.throws(()=>l.restore({version:0,graphVersion:"g2",seed:7,weights:{}}));});
