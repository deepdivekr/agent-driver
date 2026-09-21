import test from 'node:test';
import assert from 'node:assert/strict';
import {TRAVEL_PRICE_WATCH_DEMO_TARGETS,bookingSearchUrl,googleFlightsSearchUrl,parseGoogleFlightsPriceSamples,parseKrwPriceSamples,priceAlertCandidate} from '../dist/taskpacks/travel-price-watch.js';

const flight=TRAVEL_PRICE_WATCH_DEMO_TARGETS.find(target=>target.source==='google_flights');
const hotel=TRAVEL_PRICE_WATCH_DEMO_TARGETS.find(target=>target.source==='booking');

test('runtime contract travel price watch builds deterministic public search URLs without credentials or booking parameters',()=>{
  assert.ok(flight);assert.ok(hotel);
  const flights=googleFlightsSearchUrl(flight),booking=bookingSearchUrl(hotel);
  assert.match(flights,/^https:\/\/www\.google\.com\/travel\/flights\?tfs=/);assert.match(flights,/curr=KRW/);assert.equal(flights.includes('password'),false);
  const stay=new URL(booking);assert.equal(stay.origin,'https://www.booking.com');assert.equal(stay.pathname,'/searchresults.en-us.html');assert.equal(stay.searchParams.get('ss'),'Tokyo');assert.equal(stay.searchParams.get('dest_id'),'-246227');assert.equal(stay.searchParams.get('dest_type'),'city');assert.equal(stay.searchParams.get('checkin'),'2026-11-01');assert.equal(stay.searchParams.get('checkout'),'2026-11-10');assert.equal(stay.searchParams.has('reservation'),false);
});

test('runtime contract travel price watch keeps source text out of price evidence and proposes alerts without sending one',()=>{
  assert.ok(flight);
  const samples=parseKrwPriceSamples(['Sample route from Seoul to Tokyo ₩244,500 · operator text']);
  assert.deepEqual(samples.map(sample=>({amount:sample.amount,currency:sample.currency})),[{amount:244500,currency:'KRW'}]);assert.equal(samples[0].evidence_sha256.length,64);
  const observed={target_id:flight.target_id,source:flight.source,status:'observed',checked_at:'2026-09-21T00:00:00.000Z',url:googleFlightsSearchUrl(flight),prices:samples};
  assert.deepEqual(priceAlertCandidate(flight,observed),{target_id:flight.target_id,status:'threshold_met',current_lowest:244500,threshold:500000});
  assert.deepEqual(priceAlertCandidate(flight,{...observed,status:'blocked',prices:[],reason:'challenge_or_security_gate'}),{target_id:flight.target_id,status:'no_data'});
});

test('runtime contract Google Flights parser excludes price-insight prose from itinerary fares',()=>{
  assert.deepEqual(parseGoogleFlightsPriceSamples('Cheapest from ₩244,500\n₩244,500\nPrices are currently low — ₩146,600 cheaper than usual\n₩254,500').map(sample=>sample.amount),[244500,254500]);
});
