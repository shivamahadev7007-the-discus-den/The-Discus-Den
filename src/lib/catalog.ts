export type Strain = {
  id: string;
  name: string;
  size: string;
  line: string;
  tone: "platinum" | "tiger" | "rose" | "gold" | "blue" | "wild";
  photo?: string;
};

/** Hand-picked window stock. Not wired to the books. Prices come in phase 2. */
export const strains: Strain[] = [
  {
    id: "tiger-turquoise",
    name: "Tiger Turquoise",
    size: "3.5–4 inch",
    line: "Chennai-raised. Stripes coming in hard.",
    tone: "tiger",
    photo: "/strains/tiger-turquoise.jpg",
  },
  {
    id: "wild-red-rose",
    name: "Wild Red Rose",
    size: "4 inch",
    line: "Rose hue with wild face striations.",
    tone: "rose",
    photo: "/strains/wild-red-rose.jpg",
  },
  {
    id: "yellow-panda-eagles",
    name: "Yellow Panda Eagles",
    size: "4–4.5 inch",
    line: "Warm gold with fine white spotting. Den-raised.",
    tone: "gold",
    photo: "/strains/yellow-panda-eagles.jpg",
  },
  {
    id: "blue-diamond",
    name: "Blue Diamond",
    size: "4.5 inch",
    line: "Electric blue. The Den classic.",
    tone: "blue",
    photo: "/strains/blue-diamond.jpg",
  },
  {
    id: "red-checkerboards",
    name: "Red Checkerboards",
    size: "3.5–3.75 inch",
    line: "Red netting. Tight checks. Den-raised.",
    tone: "rose",
    photo: "/strains/red-checkerboards.jpg",
  },
  {
    id: "red-ninja",
    name: "Red Ninja Discus",
    size: "4 inch",
    line: "Red body. White face. A bluish rim on the fin edges.",
    tone: "rose",
    photo: "/strains/red-ninja.jpg",
  },
  {
    id: "albino-platinum",
    name: "Albino Platinum",
    size: "3–3.5 inch",
    line: "Clean white body, soft rose blush.",
    tone: "platinum",
    photo: "/strains/albino-platinum.jpg",
  },
  {
    id: "yellow-diamonds",
    name: "Yellow Diamonds",
    size: "2–2.5 inch",
    line: "Lemon yellow. Exotic and beautiful.",
    tone: "gold",
    photo: "/strains/yellow-diamonds.png",
  },
];
