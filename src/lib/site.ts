export const site = {
  brand: "The Discus Den",
  owner: "Shiva",
  city: "Chennai",
  tagline: "Exclusive discus. Raised in the Den.",
  whatsappDigits: "9363011707",
  whatsappE164: "919363011707",
  instagram: "the.discus.den",
  instagramUrl: "https://www.instagram.com/the.discus.den/",
  youtubeUrl: "https://www.youtube.com/@The-Discus-Den",
  email: "enquire@thediscusden.com",
  shipStates: [
    "Tamil Nadu",
    "Kerala",
    "Karnataka",
    "Andhra Pradesh",
    "Telangana",
  ],
} as const;

export function waLink(message?: string) {
  const text = encodeURIComponent(
    message ?? "Hi Shiva - writing from The Discus Den.",
  );
  return `https://wa.me/${site.whatsappE164}?text=${text}`;
}

export function waEnquire(strain: string) {
  return waLink(
    `Hi Shiva, I saw ${strain} on The Discus Den and I'd like to know more.`,
  );
}
