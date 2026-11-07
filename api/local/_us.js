/** US lookup tables for the Local SHTF gauge (state FIPS, names, hub airports, grid regions). */

export const STATES = {
  AL: ['01', 'Alabama'], AK: ['02', 'Alaska'], AZ: ['04', 'Arizona'], AR: ['05', 'Arkansas'], CA: ['06', 'California'],
  CO: ['08', 'Colorado'], CT: ['09', 'Connecticut'], DE: ['10', 'Delaware'], DC: ['11', 'District of Columbia'], FL: ['12', 'Florida'],
  GA: ['13', 'Georgia'], HI: ['15', 'Hawaii'], ID: ['16', 'Idaho'], IL: ['17', 'Illinois'], IN: ['18', 'Indiana'], IA: ['19', 'Iowa'],
  KS: ['20', 'Kansas'], KY: ['21', 'Kentucky'], LA: ['22', 'Louisiana'], ME: ['23', 'Maine'], MD: ['24', 'Maryland'],
  MA: ['25', 'Massachusetts'], MI: ['26', 'Michigan'], MN: ['27', 'Minnesota'], MS: ['28', 'Mississippi'], MO: ['29', 'Missouri'],
  MT: ['30', 'Montana'], NE: ['31', 'Nebraska'], NV: ['32', 'Nevada'], NH: ['33', 'New Hampshire'], NJ: ['34', 'New Jersey'],
  NM: ['35', 'New Mexico'], NY: ['36', 'New York'], NC: ['37', 'North Carolina'], ND: ['38', 'North Dakota'], OH: ['39', 'Ohio'],
  OK: ['40', 'Oklahoma'], OR: ['41', 'Oregon'], PA: ['42', 'Pennsylvania'], RI: ['44', 'Rhode Island'], SC: ['45', 'South Carolina'],
  SD: ['46', 'South Dakota'], TN: ['47', 'Tennessee'], TX: ['48', 'Texas'], UT: ['49', 'Utah'], VT: ['50', 'Vermont'],
  VA: ['51', 'Virginia'], WA: ['53', 'Washington'], WV: ['54', 'West Virginia'], WI: ['55', 'Wisconsin'], WY: ['56', 'Wyoming'],
  PR: ['72', 'Puerto Rico'],
};

/** Large commercial airports per state (FAA NAS status uses these 3-letter IDs). */
export const STATE_AIRPORTS = {
  AL: ['BHM', 'HSV'], AK: ['ANC', 'FAI'], AZ: ['PHX', 'TUS'], AR: ['LIT', 'XNA'], CA: ['LAX', 'SFO', 'SAN', 'SJC', 'OAK', 'SMF', 'BUR', 'SNA', 'ONT'],
  CO: ['DEN', 'COS'], CT: ['BDL'], DE: ['ILG'], DC: ['DCA', 'IAD'], FL: ['MCO', 'MIA', 'FLL', 'TPA', 'JAX', 'RSW', 'PBI'],
  GA: ['ATL', 'SAV'], HI: ['HNL', 'OGG'], ID: ['BOI'], IL: ['ORD', 'MDW'], IN: ['IND'], IA: ['DSM'], KS: ['ICT'], KY: ['SDF', 'CVG'],
  LA: ['MSY'], ME: ['PWM'], MD: ['BWI'], MA: ['BOS'], MI: ['DTW', 'GRR'], MN: ['MSP'], MS: ['JAN'], MO: ['STL', 'MCI'], MT: ['BZN'],
  NE: ['OMA'], NV: ['LAS', 'RNO'], NH: ['MHT'], NJ: ['EWR'], NM: ['ABQ'], NY: ['JFK', 'LGA', 'BUF', 'ALB', 'ROC', 'SYR'],
  NC: ['CLT', 'RDU'], ND: ['FAR'], OH: ['CLE', 'CMH', 'CVG'], OK: ['OKC', 'TUL'], OR: ['PDX'], PA: ['PHL', 'PIT'], RI: ['PVD'],
  SC: ['CHS', 'GSP'], SD: ['FSD'], TN: ['BNA', 'MEM'], TX: ['DFW', 'IAH', 'AUS', 'DAL', 'HOU', 'SAT', 'ELP'], UT: ['SLC'], VT: ['BTV'],
  VA: ['IAD', 'DCA', 'RIC', 'ORF'], WA: ['SEA', 'GEG'], WV: ['CRW'], WI: ['MKE', 'MSN'], WY: ['JAC'], PR: ['SJU'],
};

/** Approximate EIA balancing authority / RTO per state (respondent codes for electricity/rto). */
export const STATE_GRID_REGION = {
  NY: 'NYIS', CA: 'CISO', TX: 'ERCO', MA: 'ISNE', CT: 'ISNE', RI: 'ISNE', NH: 'ISNE', VT: 'ISNE', ME: 'ISNE',
  PA: 'PJM', NJ: 'PJM', MD: 'PJM', DE: 'PJM', DC: 'PJM', VA: 'PJM', WV: 'PJM', OH: 'PJM', KY: 'PJM',
  IL: 'MISO', IN: 'MISO', MI: 'MISO', WI: 'MISO', MN: 'MISO', IA: 'MISO', MO: 'MISO', AR: 'MISO', LA: 'MISO', MS: 'MISO', ND: 'MISO',
  KS: 'SWPP', OK: 'SWPP', NE: 'SWPP', SD: 'SWPP', NM: 'SWPP',
  FL: 'FPL', GA: 'SOCO', AL: 'SOCO', NC: 'DUK', SC: 'DUK', TN: 'TVA',
  WA: 'BPAT', OR: 'BPAT', ID: 'IPCO', AZ: 'AZPS', NV: 'NEVP', UT: 'PACE', WY: 'PACE', CO: 'PSCO', MT: 'NWMT',
};
