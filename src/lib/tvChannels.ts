/**
 * STAYBLZ TV — the official racetrack YouTube channels shown on the TV page.
 *
 * Checked 2026-11-23: each id was resolved from the track's own handle or website link, and the
 * channel was active (recent uploads). `streamsCards` = the track streams live racing on YouTube
 * (whole cards or big race days), so it can show up under Live; the others post race replays and
 * highlights only. Tracks with no official, active channel (or one with only marketing videos) are left out.
 *
 * Extra channels can be added without a code change through TV_YOUTUBE_CHANNELS, and the whole
 * list can be turned off with TV_YOUTUBE_DEFAULTS=off (see lib/youtubeFeed.ts).
 */
export type Breed = "Thoroughbred" | "Quarter Horse" | "Harness";

export interface TvChannel {
  id: string;
  /** The YouTube handle, for people maintaining this list. */
  handle: string | null;
  /** What the page calls the channel. */
  name: string;
  /** The track(s) it covers. */
  track: string;
  breed: Breed;
  streamsCards: boolean;
}

export const TV_CHANNELS: readonly TvChannel[] = [
  // Live racing on YouTube
  { id: "UCzU39Vjjyv2_SXipboFPAsQ", handle: "@losalqh", name: "Los Alamitos", track: "Los Alamitos Race Course", breed: "Quarter Horse", streamsCards: true },
  { id: "UC7NsS9H61hQ51JLeaHHeivA", handle: "@delmarracing", name: "Del Mar", track: "Del Mar", breed: "Thoroughbred", streamsCards: true },
  { id: "UCxRmRUB3kX-X-_9YsNFhq3g", handle: "@TheNYRA", name: "NYRA", track: "Aqueduct · Belmont · Saratoga", breed: "Thoroughbred", streamsCards: true },
  { id: "UCCFE0waoK25hBQJ9qdqRj-A", handle: "@LoneStarPark", name: "Lone Star Park", track: "Lone Star Park", breed: "Thoroughbred", streamsCards: true },
  { id: "UCrz1qpBkxIfPzgirQwLMgtw", handle: "@FingerLakesRacetrack", name: "Finger Lakes", track: "Finger Lakes", breed: "Thoroughbred", streamsCards: true },
  { id: "UCWO_eO7rvP4q_cMp-RAeS2g", handle: "@emeralddowns", name: "Emerald Downs", track: "Emerald Downs", breed: "Thoroughbred", streamsCards: true },
  { id: "UCG0_hb2Wn162aTByGP2dDlw", handle: "@kydownsracing", name: "Kentucky Downs", track: "Kentucky Downs", breed: "Thoroughbred", streamsCards: true },
  { id: "UCbmRDQAke5nnEihWtAgZ8pg", handle: "@canterburypark", name: "Canterbury Park", track: "Canterbury Park", breed: "Thoroughbred", streamsCards: true },
  { id: "UC5OHLkjF6EHBqEwgwG7ip2Q", handle: "@keenelandofficial", name: "Keeneland", track: "Keeneland", breed: "Thoroughbred", streamsCards: true },
  { id: "UC0RagnaQvFUM5BJUCIxWKow", handle: null, name: "Woodbine", track: "Woodbine · Mohawk", breed: "Thoroughbred", streamsCards: true },
  { id: "UCnsKaOapfK9PHDaSxGnynhA", handle: "@MeadowlandsRacetrack", name: "Meadowlands", track: "Meadowlands", breed: "Harness", streamsCards: true },
  { id: "UCkhBqbxs8CbO-vYxKROF73g", handle: "@RedShoresRacetrack", name: "Red Shores", track: "Red Shores (Charlottetown)", breed: "Harness", streamsCards: true },
  { id: "UCYXo5h4lHOg3PaiZPUmjr1g", handle: "@TruroRaceway", name: "Truro Raceway", track: "Truro Raceway", breed: "Harness", streamsCards: true },
  // Replays and highlights only (live racing goes to FanDuel TV / TVG / the track's own site)
  { id: "UCe3xqxd95jp8W6m_O93L-hg", handle: "@GulfstreamParkRacing", name: "Gulfstream Park", track: "Gulfstream Park", breed: "Thoroughbred", streamsCards: false },
  { id: "UCjtpY_CgDJ2GNdRzlXdmiGA", handle: "@KentuckyDerby", name: "Churchill Downs", track: "Churchill Downs (Kentucky Derby)", breed: "Thoroughbred", streamsCards: false },
  { id: "UCwfDNxjL1VPZ8iFyAVUQqZA", handle: null, name: "Santa Anita", track: "Santa Anita Park", breed: "Thoroughbred", streamsCards: false },
  { id: "UCZPwm5nBXbeRLYA5QB1OZaQ", handle: "@MarylandRacing", name: "Maryland Racing", track: "Laurel Park · Pimlico", breed: "Thoroughbred", streamsCards: false },
  { id: "UCyw6y9RUXwdU6vQx9bILvHg", handle: "@OfficialParxRacing", name: "Parx Racing", track: "Parx", breed: "Thoroughbred", streamsCards: false },
  { id: "UCRM026djgG4bvetWOWsR1Og", handle: "@MonmouthPark", name: "Monmouth Park", track: "Monmouth Park", breed: "Thoroughbred", streamsCards: false },
  { id: "UCTgvWN_n-Qk0v5Qtebvq7Mw", handle: null, name: "Delaware Park", track: "Delaware Park", breed: "Thoroughbred", streamsCards: false },
  { id: "UCXV1TTnYiXpUeAQi68YnQ9g", handle: "@CenturyMile", name: "Century Mile", track: "Century Mile", breed: "Thoroughbred", streamsCards: false },
];

const BY_ID = new Map(TV_CHANNELS.map((c) => [c.id, c]));

export function tvChannel(id: string): TvChannel | undefined {
  return BY_ID.get(id);
}
