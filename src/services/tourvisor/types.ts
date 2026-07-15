/**
 * Tourvisor XML/JSON API response shapes (subset).
 * Base: http://tourvisor.ru/xml/  — auth via authlogin/authpass, format=json.
 *
 * NOTE: Tourvisor's JSON frequently returns numbers as strings and single-item
 * arrays as bare objects. Parsing code below is defensive about both.
 */

export interface TvDeparture {
  id: string;
  name: string;
  namefrom?: string;
}

export interface TvCountry {
  id: string;
  name: string;
}

export interface TvListDeparturesResponse {
  lists?: { departures?: { departure?: TvDeparture[] | TvDeparture } };
}

export interface TvListCountriesResponse {
  lists?: { countries?: { country?: TvCountry[] | TvCountry } };
}

/** A hotel as returned by the reference list (list.php?type=hotel&hotcountry=…). */
export interface TvRefHotel {
  id: string;
  name: string;
  stars?: number | string;
  rating?: number | string;
  region?: string; // region id (reference list returns codes, not names)
  subregion?: string;
}

export interface TvListHotelsResponse {
  lists?: { hotels?: { hotel?: TvRefHotel[] | TvRefHotel } };
}

export interface TvSearchResponse {
  result?: { requestid?: number | string; error?: string };
  error?: string;
}

export interface TvStatus {
  state?: string; // "searching" | "finished"
  progress?: number | string;
  hotelsfound?: number | string;
  toursfound?: number | string;
  minprice?: number | string;
  timepassed?: number | string; // seconds since search start
}

export interface TvTour {
  tourid?: string;
  operatorname?: string;
  flydate?: string; // dd.mm.yyyy
  nights?: number | string;
  price?: number | string;
  currency?: string;
  meal?: string;
  mealrussian?: string;
  room?: string;
  hotelstatus?: string;
}

export interface TvHotel {
  hotelcode?: string;
  hotelname?: string;
  hotelstars?: number | string;
  hotelrating?: number | string;
  regionname?: string;
  countryname?: string;
  price?: number | string;
  picturelink?: string;
  fulldesclink?: string;
  reviewlink?: string;
  seadistance?: number | string;
  tours?: { tour?: TvTour[] | TvTour };
}

export interface TvResultResponse {
  data?: {
    status?: TvStatus;
    result?: { hotel?: TvHotel[] | TvHotel };
  };
  status?: TvStatus; // some responses put status at top level
  error?: string;
}
