import {type Page} from 'playwright';
import {type AdaptiveTask,hashJson} from '../taskpack/adaptive-spec.js';
import {publicBrowserUrl} from '../taskpack/adaptive-decision.js';
import {type AdaptiveVerification} from '../taskpack/adaptive-runner.js';
import {googleFlightsSearchUrl,bookingSearchUrl,parseGoogleFlightsPriceSamples,type TravelPriceTarget} from './travel-price-watch.js';

export const ADAPTIVE_TRAVEL_TARGETS:readonly TravelPriceTarget[]=[
  {target_id:'seoul-tokyo-flight',source:'google_flights',origin:'ICN',destination:'NRT',departure_date:'2026-11-01',return_date:'2026-11-10',currency:'KRW'},
  {target_id:'tokyo-year-end-five-star',source:'booking',destination:'Tokyo',destination_id:'-246227',destination_type:'city',check_in:'2026-12-28',check_out:'2027-01-02',adults:2,rooms:1,currency:'KRW'},
];
export function adaptiveTravelTask(target:TravelPriceTarget):AdaptiveTask {
  if(target.source==='google_flights')return {
    request:`Find the cheapest round-trip flights from Seoul ICN to Tokyo NRT, departing ${target.departure_date} and returning ${target.return_date}, 1 adult, economy, in KRW. Use the Cheapest results tab and verify the applied dates and airports. Search only; do not select a booking provider, book, pay, or sign in.`,
    start_url:googleFlightsSearchUrl(target),allowed_origins:['https://www.google.com'],
  };
  const url=new URL(bookingSearchUrl(target));url.searchParams.delete('order');
  return {
    request:`Find the lowest available total stay price for 5-star hotels in Tokyo, checking in ${target.check_in} and checking out ${target.check_out}, ${target.adults} adults, ${target.rooms} room, in KRW. Apply the 5-star hotel classification filter, NOT a guest review score. Sort by lowest price. Dismiss unrelated promotional popups when needed. Compare total prices for the full 5-night stay with the same tax basis. Search only; do not reserve, book, pay, log in, sign up, or accept optional consent.`,
    start_url:url.toString(),allowed_origins:['https://www.booking.com'],
  };
}
export interface HotelPriceCard {
  name:string;url:string;stars:number|null;amount:number|null;currency:'KRW'|null;
  nights:number|null;adults:number|null;tax_basis:'included'|'excluded'|'unknown';evidence_sha256:string;
}
export interface BookingReadback {
  destination_matches:boolean;dates_match:boolean;occupancy_matches:boolean;five_star_filter:boolean;price_sort:boolean;cards:HotelPriceCard[];
}
export function verifyBookingReadback(readback:BookingReadback,target:Extract<TravelPriceTarget,{source:'booking'}>):AdaptiveVerification {
  const nights=(Date.parse(target.check_out)-Date.parse(target.check_in))/86400000;
  const conditions=readback.destination_matches&&readback.dates_match&&readback.occupancy_matches&&readback.five_star_filter&&readback.price_sort;
  const eligible=readback.cards.filter(card=>card.stars===5&&card.amount!==null&&card.amount>0&&card.currency==='KRW'&&card.nights===nights&&card.adults===target.adults&&card.tax_basis!=='unknown');
  // Mixed tax bases cannot be silently ranked as one pool.
  const pools=(['included','excluded'] as const).map(tax_basis=>({tax_basis,candidates:eligible.filter(card=>card.tax_basis===tax_basis).sort((a,b)=>a.amount!-b.amount!)})).filter(pool=>pool.candidates.length);
  return {status:conditions&&eligible.length?'MATCH':readback.cards.length?'NOT_MATCH':'UNKNOWN',reason:conditions&&eligible.length?'verified_five_star_observed_prices':'conditions_or_comparable_prices_missing',details:{conditions:{destination:readback.destination_matches,dates:readback.dates_match,occupancy:readback.occupancy_matches,five_star_filter:readback.five_star_filter,price_sort:readback.price_sort},nights,rooms:target.rooms,observed_cards:readback.cards.length,eligible_cards:eligible.length,price_unit:'entire_stay_per_requested_room_count',coverage:'currently_rendered_cards_not_entire_inventory',lowest_by_tax_basis:pools.map(pool=>({tax_basis:pool.tax_basis,lowest_observed:pool.candidates[0],candidates:pool.candidates.slice(0,5)}))}};
}
function amountKrw(text:string){const match=text.match(/(?:KRW\s*|₩\s*)([\d,]+)/u);return match?Number(match[1]!.replaceAll(',','')):null;}
export async function readBookingResults(page:Page,target:Extract<TravelPriceTarget,{source:'booking'}>):Promise<BookingReadback>{
  const url=new URL(page.url()),params=new URLSearchParams(url.search.slice(1).replaceAll(';','&')),body=await page.locator('body').innerText(),raw=await page.locator('[data-testid="property-card"]').evaluateAll(nodes=>nodes.slice(0,30).map(card=>{
    const text=card.textContent??'',stars=card.querySelector('[data-testid="rating-stars"]');
    const price=card.querySelector('[data-testid="price-and-discounted-price"]');
    const starLabel=stars?.getAttribute('aria-label')??'';
    const rating=starLabel.match(/(\d)\s*(?:out of|star|성급)/iu);
    return {name:card.querySelector('[data-testid="title"]')?.textContent??'',url:(card.querySelector('[data-testid="title-link"]') as HTMLAnchorElement|null)?.href??'',stars:rating?Number(rating[1]):stars?stars.querySelectorAll('svg').length:null,price:price?.textContent??'',text};
  }));
  const starsChecked=await page.getByRole('checkbox',{name:/^(?:5 stars\b|5성급)/iu}).first().isChecked().catch(()=>false);
  const sortLabel=await page.locator('[data-testid="sorters-dropdown-trigger"]').innerText().catch(()=>'');
  const cards:HotelPriceCard[]=raw.map(card=>({name:card.name,url:publicBrowserUrl(card.url),stars:card.stars,amount:amountKrw(card.price),currency:/(?:KRW|₩)/u.test(card.price)?'KRW':null,nights:Number(card.text.match(/(\d+)\s*(?:nights?|박)/iu)?.[1])||null,adults:Number(card.text.match(/(\d+)\s*adults?/iu)?.[1]??card.text.match(/성인\s*(\d+)/u)?.[1])||null,tax_basis:/includes taxes|taxes and charges included|세금.*포함/iu.test(card.text)&&!/불포함/u.test(card.text)?'included':/excludes taxes|\+.*taxes|additional charges|세금.*불포함/iu.test(card.text)?'excluded':'unknown',evidence_sha256:hashJson(card)}));
  const destination=target.destination.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
  return {destination_matches:params.get('dest_id')===target.destination_id&&(new RegExp(destination,'iu').test(body)||(target.destination==='Tokyo'&&/도쿄/u.test(body))),dates_match:params.get('checkin')===target.check_in&&params.get('checkout')===target.check_out,occupancy_matches:params.get('group_adults')===String(target.adults)&&params.get('no_rooms')===String(target.rooms),five_star_filter:starsChecked||/(?:^|;)class=5(?:;|$)/u.test(params.get('nflt')??''),price_sort:/price.*lowest|lowest.*price|낮은.*(?:요금|가격)|(?:요금|가격).*낮은/iu.test(sortLabel),cards};
}
/** Read only the route/passenger/cabin fields we encode; sorting may add others. */
export function googleRouteMatches(actualUrl:string,target:Extract<TravelPriceTarget,{source:'google_flights'}>):boolean {
  try {
    const url=new URL(actualUrl),encoded=url.searchParams.get('tfs');if(!encoded||encoded.length>16000||url.searchParams.get('curr')!=='KRW')return false;
    const decode=(bytes:Buffer)=>{
      const fields=new Map<number,(number|Buffer)[]>();let offset=0;
      const integer=()=>{let value=0,shift=0;while(offset<bytes.length&&shift<=49){const byte=bytes[offset++]!;value+=(byte&127)*2**shift;if(!(byte&128))return value;shift+=7;}throw Error('INVALID_VARINT');};
      while(offset<bytes.length){const key=integer(),field=Math.floor(key/8),wire=key%8;let value:number|Buffer;
        if(wire===0)value=integer();else if(wire===2){const length=integer();if(length>bytes.length-offset)throw Error('INVALID_LENGTH');value=bytes.subarray(offset,offset+length);offset+=length;}
        else if(wire===1||wire===5){offset+=wire===1?8:4;if(offset>bytes.length)throw Error('INVALID_LENGTH');continue;}else throw Error('INVALID_WIRE');
        fields.set(field,[...(fields.get(field)??[]),value]);
      }return fields;
    };
    const root=decode(Buffer.from(encoded,'base64url')),legs=root.get(3)??[];
    const one=(fields:Map<number,(number|Buffer)[]>,key:number)=>{const values=fields.get(key);if(values?.length!==1)throw Error('FIELD_COUNT');return values[0]!;};
    const str=(value:number|Buffer)=>{if(!Buffer.isBuffer(value))throw Error('FIELD_TYPE');return value.toString('utf8');};
    const airport=(value:number|Buffer)=>{if(!Buffer.isBuffer(value))throw Error('FIELD_TYPE');const fields=decode(value);if(one(fields,1)!==1)throw Error('PLACE_TYPE');return str(one(fields,2));};
    if(legs.length!==2||one(root,8)!==1||one(root,9)!==1)return false;
    return legs.every((leg,index)=>{if(!Buffer.isBuffer(leg))return false;const fields=decode(leg);return str(one(fields,2))===(index?target.return_date:target.departure_date)&&airport(one(fields,13))===(index?target.destination:target.origin)&&airport(one(fields,14))===(index?target.origin:target.destination);});
  } catch{return false;}
}
export async function verifyAdaptiveTravel(page:Page,target:TravelPriceTarget):Promise<AdaptiveVerification>{
  if(target.source==='booking')return verifyBookingReadback(await readBookingResults(page,target),target);
  const body=await page.locator('body').innerText(),prices=parseGoogleFlightsPriceSamples(body),url=new URL(page.url()),expected=new URL(googleFlightsSearchUrl(target));
  const cheapest=page.getByRole('tab',{name:/cheapest/iu}).first();
  const selected=await cheapest.getAttribute('aria-selected').catch(()=>null);
  const routeUnchanged=url.searchParams.get('tfs')===expected.searchParams.get('tfs');
  const routeMatches=googleRouteMatches(page.url(),target);
  const visibleRoute=/Seoul|ICN/iu.test(body)&&/Tokyo|NRT/iu.test(body);
  const matched=routeMatches&&visibleRoute&&selected==='true'&&prices.length>0;
  return {status:matched?'MATCH':prices.length?'NOT_MATCH':'UNKNOWN',reason:matched?'cheapest_tab_and_seeded_route_verified':'route_tab_or_price_unverified',details:{route_parameter_unchanged:routeUnchanged,route_conditions_match:routeMatches,route_visible:visibleRoute,cheapest_tab_selected:selected==='true',price_samples:prices.length,lowest_observed:prices.length?Math.min(...prices.map(price=>price.amount)):null,currency:'KRW',coverage:'currently_rendered_fare_lines',seeded_search:true,requested_target:target}};
}
