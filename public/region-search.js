const suffixPattern = /(特别行政区|壮族自治区|回族自治区|维吾尔自治区|自治区|自治州|自治县|自治旗|地区|盟|省|市|区|县|旗)$/;
const normalize = (value) => String(value || "").replace(/\s+/g, "").toLowerCase();
const shortName = (value) => normalize(value).replace(suffixPattern, "");

function pathOf(region) {
  const parts = [region.province];
  if (region.city && region.city !== region.province) parts.push(region.city);
  if (region.name && !parts.includes(region.name)) parts.push(region.name);
  return normalize(parts.join(""));
}

export function searchRegions(regions, query, limit = 50) {
  const normalizedQuery = normalize(query);
  const shortQuery = shortName(query);
  if (!normalizedQuery) return [];

  const exactPath = [];
  const exactName = [];
  const partial = [];
  for (const region of regions) {
    const name = normalize(region.name);
    const path = pathOf(region);
    if (path === normalizedQuery) exactPath.push(region);
    else if (name === normalizedQuery || shortName(region.name) === shortQuery) exactName.push(region);
    else if (path.includes(normalizedQuery) || name.includes(normalizedQuery)) partial.push(region);
  }

  const exact = exactPath.length ? exactPath : exactName;
  const expanded = [];
  exact.forEach((region) => {
    expanded.push(region);
    if (region.level !== "district") {
      regions
        .filter((candidate) => candidate.parent === region.adcode && candidate.level === "district")
        .forEach((candidate) => expanded.push(candidate));
    }
  });

  const source = exact.length ? expanded : partial;
  const unique = new Map();
  source.forEach((region) => {
    if (!unique.has(region.adcode)) unique.set(region.adcode, region);
  });
  return [...unique.values()].slice(0, limit);
}

export function regionToLocation(region) {
  return {
    id: `cn-${region.adcode}`,
    name: region.name,
    admin1: region.province || "",
    admin2: region.city || "",
    country: "中国",
    latitude: Number(region.lat),
    longitude: Number(region.lng),
    timezone: "Asia/Shanghai",
  };
}

export function regionPath(region) {
  return [region.province, region.city !== region.province ? region.city : "", region.name]
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(" · ");
}
