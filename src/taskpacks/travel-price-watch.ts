import {createHash} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {requireCondition} from '../core/contracts.js';
import {OwnedPersistentPage} from '../taskpack/owned-playwright.js';

const ymd=z.string().regex(/^20\d\d-\d\d-\d\d$/);
const iata=z.string().regex(/^[A-Z]{3}$/);
const price=z.number().int().positive().max(100_000_000);
export const googleFlightsTarget=z.object({
  target_id:z.string().regex(/^[a-z][a-z0-9-]{2,63}$/),source:z.literal('google_flights'),origin:iata,destination:iata,departure_date:ymd,return_date:ymd,currency:z.literal('KRW'),alert_at_or_below:price.optional(),
}).strict();
export const bookingTarget=z.object({
  target_id:z.string().regex(/^[a-z][a-z0-9-]{2,63}$/),source:z.literal('booking'),destination:z.string().min(2).max(120),destination_id:z.string().regex(/^-?[0-9]{1,20}$/).optional(),destination_type:z.enum(['city','region','hotel']).optional(),check_in:ymd,check_out:ymd,adults:z.number().int().min(1).max(8),rooms:z.number().int().min(1).max(8),currency:z.literal('KRW'),alert_at_or_below:price.optional(),
}).strict();
export const travelPriceTarget=z.discriminatedUnion('source',[googleFlightsTarget,bookingTarget]);
export type TravelPriceTarget=z.infer<typeof travelPriceTarget>;

export const TRAVEL_PRICE_WATCH_DEMO_TARGETS:readonly TravelPriceTarget[]=[
  {target_id:'seoul-tokyo-flight',source:'google_flights',origin:'ICN',destination:'NRT',departure_date:'2026-11-01',return_date:'2026-11-10',currency:'KRW',alert_at_or_below:500_000},
  {target_id:'tokyo-stay',source:'booking',destination:'Tokyo',destination_id:'-246227',destination_type:'city',check_in:'2026-11-01',check_out:'2026-11-10',adults:1,rooms:1,currency:'KRW',alert_at_or_below:300_000},
] as const;

export type PriceObservationStatus='observed'|'blocked'|'unobserved';
export interface PriceSample {amount:number;currency:'KRW';evidence_sha256:string;}
export interface TravelPriceObservation {
  target_id:string;source:TravelPriceTarget['source'];status:PriceObservationStatus;checked_at:string;url:string;prices:readonly PriceSample[];capture_ref?:string;video_ref?:string;reason?:'challenge_or_security_gate'|'privacy_consent_required'|'result_not_observed'|'source_navigation_failed';
}
export interface PriceAlertCandidate {target_id:string;status:'threshold_met'|'price_drop'|'no_alert'|'no_data';current_lowest?:number;previous_lowest?:number;threshold?:number;}
export interface TravelPriceWatchReceipt {format:1;kind:'travel_price_watch';targets:readonly TravelPriceObservation[];alerts:readonly PriceAlertCandidate[];external_notifications:0;disclosure:string;}

function concat(...chunks:readonly Uint8Array[]){const size=chunks.reduce((sum,chunk)=>sum+chunk.length,0),result=new Uint8Array(size);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length;}return result;}
function varint(value:number){requireCondition(Number.isInteger(value)&&value>=0&&value<=0x7fff_ffff,'INVALID_PROTOBUF_VARINT');const bytes:number[]=[];let next=value;do{const low=next&0x7f;next=Math.floor(next/128);bytes.push(next===0?low:low|0x80);}while(next!==0);return Uint8Array.from(bytes);}
function fieldNumber(field:number,wire:0|2){return varint(field*8+wire);}
function encodedString(field:number,value:string){const body=new TextEncoder().encode(value);return concat(fieldNumber(field,2),varint(body.length),body);}
function encodedVarint(field:number,value:number){return concat(fieldNumber(field,0),varint(value));}
function encodedMessage(field:number,value:Uint8Array){return concat(fieldNumber(field,2),varint(value.length),value);}
function place(code:string){return concat(encodedVarint(1,1),encodedString(2,code));}
function flightLeg(date:string,origin:string,destination:string){return concat(encodedString(2,date),encodedMessage(13,place(origin)),encodedMessage(14,place(destination)));}

/** Builds a public Google Flights search deep link without form-click replay. */
export function googleFlightsSearchUrl(target:Extract<TravelPriceTarget,{source:'google_flights'}>){
  const value=googleFlightsTarget.parse(target);requireCondition(value.return_date>value.departure_date,'FLIGHT_RETURN_MUST_FOLLOW_DEPARTURE');
  const proto=concat(encodedVarint(2,0),encodedMessage(3,flightLeg(value.departure_date,value.origin,value.destination)),encodedMessage(3,flightLeg(value.return_date,value.destination,value.origin)),encodedVarint(8,1),encodedVarint(9,1),encodedVarint(19,1));
  const tfs=Buffer.from(proto).toString('base64url');return `https://www.google.com/travel/flights?tfs=${encodeURIComponent(tfs)}&curr=${value.currency}&hl=en&gl=KR`;
}
export function bookingSearchUrl(target:Extract<TravelPriceTarget,{source:'booking'}>){
  const value=bookingTarget.parse(target);requireCondition(value.check_out>value.check_in,'BOOKING_CHECKOUT_MUST_FOLLOW_CHECKIN');const url=new URL('https://www.booking.com/searchresults.en-us.html');
  url.searchParams.set('ss',value.destination);url.searchParams.set('checkin',value.check_in);url.searchParams.set('checkout',value.check_out);url.searchParams.set('group_adults',String(value.adults));url.searchParams.set('no_rooms',String(value.rooms));url.searchParams.set('group_children','0');url.searchParams.set('selected_currency',value.currency);url.searchParams.set('lang','en-us');url.searchParams.set('order','price');if(value.destination_id!==undefined)url.searchParams.set('dest_id',value.destination_id);if(value.destination_type!==undefined)url.searchParams.set('dest_type',value.destination_type);return url.toString();
}
function captureHash(value:string){return createHash('sha256').update(value).digest('hex');}
/** Extract only bounded numeric price signals; source labels themselves are never persisted. */
export function parseKrwPriceSamples(values:readonly string[]):PriceSample[]{
  const samples:PriceSample[]=[];for(const value of values.slice(0,32)){for(const match of value.matchAll(/(?:₩|KRW\s?)([0-9][0-9,]{1,14})/gu)){const amount=Number(match[1]?.replaceAll(',',''));if(Number.isSafeInteger(amount)&&amount>0)samples.push({amount,currency:'KRW',evidence_sha256:captureHash(value)});}}
  return samples.slice(0,32);
}
/** Google Flights renders the itinerary fare as its own visible line. Price-insight prose is not a fare. */
export function parseGoogleFlightsPriceSamples(visibleText:string):PriceSample[]{
  const fareLines=visibleText.split(/\r?\n/u).map(line=>line.trim()).filter(line=>/^₩[0-9]{1,3}(?:,[0-9]{3})*$/u.test(line));
  return parseKrwPriceSamples(fareLines);
}
function targetUrl(target:TravelPriceTarget){return target.source==='google_flights'?googleFlightsSearchUrl(target):bookingSearchUrl(target);}
function gateReason(body:string):TravelPriceObservation['reason']|undefined {
  if(/captcha|unusual traffic|verify you are human|security check/iu.test(body))return 'challenge_or_security_gate';
  if(/cookie preferences|privacy settings|consent/iu.test(body))return 'privacy_consent_required';
  return undefined;
}
export function priceAlertCandidate(target:TravelPriceTarget,current:TravelPriceObservation,previousLowest?:number):PriceAlertCandidate {
  const currentLowest=current.prices.length===0?undefined:Math.min(...current.prices.map(sample=>sample.amount));
  if(current.status!=='observed'||currentLowest===undefined)return {target_id:target.target_id,status:'no_data'};
  if(target.alert_at_or_below!==undefined&&currentLowest<=target.alert_at_or_below)return {target_id:target.target_id,status:'threshold_met',current_lowest:currentLowest,threshold:target.alert_at_or_below};
  if(previousLowest!==undefined&&currentLowest<previousLowest)return {target_id:target.target_id,status:'price_drop',current_lowest:currentLowest,previous_lowest:previousLowest};
  return {target_id:target.target_id,status:'no_alert',current_lowest:currentLowest,...(previousLowest===undefined?{}:{previous_lowest:previousLowest}),...(target.alert_at_or_below===undefined?{}:{threshold:target.alert_at_or_below})};
}

/**
 * One explicit, low-volume public-source check. It never signs in, purchases,
 * accepts privacy consent, solves challenges, or sends a notification.
 */
export class OwnedTravelPriceSource {
  constructor(readonly profileDir:string,readonly captureRoot:string,readonly videoRoot?:string){}
  async collect(taskId:string,target:TravelPriceTarget):Promise<TravelPriceObservation>{
    const url=targetUrl(target),origin=new URL(url).origin,owned=new OwnedPersistentPage(this.profileDir,this.captureRoot,true,this.videoRoot===undefined?{}:{recordVideoDir:this.videoRoot,recordVideoSize:{width:1280,height:720}});
    let capture_ref:string|undefined,completed:TravelPriceObservation|undefined;
    try {
      const opened=await owned.open(taskId,{url,allowed_origins:[origin],logged_in:'body',authentication_request:'#agent-driver-auth-not-present',known_popups:[],unknown_dialog:'#agent-driver-unknown-modal',requires_logged_in:false,navigation_timeout_ms:30_000,allow_capture_failure:true});
      capture_ref=opened.capture_ref;
      if(opened.gate!=='ready'){
        completed={target_id:target.target_id,source:target.source,status:'unobserved',checked_at:new Date().toISOString(),url,prices:[],...(capture_ref===undefined?{}:{capture_ref}),reason:'source_navigation_failed'};
      } else {
        const page=owned.page,body=await page.locator('body').innerText().catch(()=>''),gate=gateReason(body);
        if(gate!==undefined){completed={target_id:target.target_id,source:target.source,status:'blocked',checked_at:new Date().toISOString(),url,prices:[],...(capture_ref===undefined?{}:{capture_ref}),reason:gate};}
        else {
          let prices:PriceSample[]=[];
          if(target.source==='google_flights'){
            prices=parseGoogleFlightsPriceSamples(body);
            if(prices.length===0){
              await page.waitForFunction(()=>/(?:₩|KRW\s?)[0-9]/u.test(document.body.innerText),undefined,{timeout:15_000}).catch(()=>undefined);
              const visibleText=await page.locator('body').innerText().catch(()=>''),labels=await page.locator('button').evaluateAll(elements=>elements.map(element=>element.getAttribute('aria-label')??element.textContent??'').filter(text=>/(?:₩|KRW\s?)[0-9]/u.test(text)).slice(0,32));
              prices=parseGoogleFlightsPriceSamples(visibleText);if(prices.length===0)prices=parseKrwPriceSamples(labels);
            }
          } else {
            const cards=page.locator('[data-testid="property-card-container"],[data-testid="property-card"]');
            await cards.first().waitFor({state:'visible',timeout:15_000}).catch(()=>undefined);
            prices=parseKrwPriceSamples(await cards.evaluateAll(elements=>elements.slice(0,16).map(element=>element.textContent??'')));
          }
          // Evidence capture is desirable, but a slow infinite-scroll source
          // must not erase a successful read-only price observation.
          const finalCapture=await owned.capture(taskId).catch(()=>undefined);if(finalCapture!==undefined)capture_ref=finalCapture.capture_ref;
          completed={target_id:target.target_id,source:target.source,status:prices.length>0?'observed':'unobserved',checked_at:new Date().toISOString(),url,prices,...(capture_ref===undefined?{}:{capture_ref}),...(prices.length>0?{}:{reason:'result_not_observed'})};
        }
      }
    } catch (error) {
      // Development-only diagnostic; never persisted in the monitor receipt.
      if(process.env.AGENT_DRIVER_TRAVEL_DEBUG==='1')process.stderr.write(`travel-price-watch source failure: ${error instanceof Error?error.message:'unknown'}\n`);
      completed={target_id:target.target_id,source:target.source,status:'unobserved',checked_at:new Date().toISOString(),url,prices:[],...(capture_ref===undefined?{}:{capture_ref}),reason:'source_navigation_failed'};
    } finally {await owned.close().catch(()=>undefined);}
    requireCondition(completed!==undefined,'PRICE_SOURCE_RESULT_MISSING');
    return {...completed,...(owned.videoPath===undefined?{}:{video_ref:owned.videoPath})};
  }
}

export async function renderTravelPriceWatchDemo(outputRoot:string,targets:readonly TravelPriceTarget[]=TRAVEL_PRICE_WATCH_DEMO_TARGETS,options:{recordVideo?:boolean}={}){
  const root=join(outputRoot,'runtime'),collector=new OwnedTravelPriceSource(join(root,'profile'),join(root,'captures'),options.recordVideo===false?undefined:join(root,'video'));await mkdir(outputRoot,{recursive:true,mode:0o700});
  const observations:TravelPriceObservation[]=[];const alerts:PriceAlertCandidate[]=[];
  for(const target of targets){const observed=await collector.collect(`travel-watch-${target.target_id}`,target);observations.push(observed);alerts.push(priceAlertCandidate(target,observed));}
  const receipt:TravelPriceWatchReceipt={format:1,kind:'travel_price_watch',targets:observations,alerts,external_notifications:0,disclosure:'One user-initiated, low-volume public search only. No sign-in, booking, payment, privacy-consent acceptance, challenge solving, or external notification was performed.'};return receipt;
}
