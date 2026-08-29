/**
 * Variantes de messages, pour que le bot ne répète pas la même phrase tous les
 * jours. Le ton suit celui du bot sport : tutoiement, direct, un emoji max.
 *
 * Les fonctions de clôture choisissent leur lot selon le taux de réalisation :
 * on ne félicite pas une journée à 0/8 comme une journée bouclée.
 */

function pick(variants: string[]): string {
  return variants[Math.floor(Math.random() * variants.length)] as string;
}

// --- 18h : préparation du lendemain ---------------------------------------

const PREP_INTROS = [
  'on prépare **{date}** ?',
  'à quoi ressemble ta journée de **{date}** ?',
  'c’est l’heure de poser **{date}** sur le papier 📝',
  'qu’est-ce qui t’attend **{date}** ?',
  'on cale le programme de **{date}** ?',
  'dis-moi ce que tu veux abattre **{date}**.',
  'petite projection : **{date}**, on fait quoi ?',
  'la journée de **{date}** est encore vierge — on la remplit ?',
];

export function prepIntro(date: string): string {
  return pick(PREP_INTROS).replace('{date}', date);
}

// --- 7h : ouverture de la journée -----------------------------------------

const BOARD_INTROS = [
  'voici ta journée 👇',
  'au programme aujourd’hui 👇',
  'ta feuille de route du jour 👇',
  'c’est parti, voilà le plan ☕',
  'debout, voici ce qui t’attend 👇',
  'ta journée est prête, plus qu’à cocher ✅',
  'on attaque — voilà le programme 💪',
  'le menu du jour 👇',
];

const BOARD_INTROS_EMPTY = [
  'aucune tâche prévue aujourd’hui — tu peux en ajouter ci-dessous.',
  'ta journée est vide pour l’instant. Tu ajoutes quelque chose ?',
  'rien de planifié aujourd’hui. Journée libre, ou tu remplis ?',
  'page blanche pour aujourd’hui — à toi de voir.',
  'rien au programme. Ajoute une tâche si ce n’est pas volontaire.',
];

export function boardIntro(taskCount: number): string {
  return taskCount > 0 ? pick(BOARD_INTROS) : pick(BOARD_INTROS_EMPTY);
}

// --- Pied de page de la checklist ------------------------------------------

const BOARD_FOOTERS = [
  'Clique sur un numéro pour cocher',
  'Un clic sur le numéro et c’est coché',
  'Coche au fil de la journée',
  'Les numéros correspondent aux boutons',
];

const ALL_DONE_FOOTERS = [
  'Tout est fait, bravo',
  'Journée bouclée, chapeau',
  'Sans faute aujourd’hui',
  'Rien qui traîne, propre',
  'Carton plein',
];

/**
 * Le pied de page est recalculé à chaque coche : un tirage aléatoire le ferait
 * sauter d'un texte à l'autre sous les yeux. On le fixe donc par journée, via
 * l'identifiant du plan — stable dans la journée, différent le lendemain.
 */
export function boardFooter(allDone: boolean, seed: number): string {
  const variants = allDone ? ALL_DONE_FOOTERS : BOARD_FOOTERS;
  return variants[Math.abs(seed) % variants.length] as string;
}

// --- Clôture de la journée -------------------------------------------------

const CLOSE_PERFECT = [
  '🏆 Journée parfaite : **{done}/{total}**. Tout y est.',
  '🎉 **{done}/{total}** — rien n’est passé à la trappe.',
  '💯 Sans faute : **{done}/{total}**. On archive.',
  '🔥 **{done}/{total}**, journée bouclée proprement.',
];

const CLOSE_GOOD = [
  '👍 Bonne journée : **{done}/{total}** de fait.',
  '✅ **{done}/{total}** — le gros est passé.',
  '🙂 **{done}/{total}**, c’est une journée solide.',
  '💪 **{done}/{total}** de bouclé, on archive.',
];

// En dessous de la moitié, le ton pique. En dessous de tout, il mord.
const CLOSE_PARTIAL = [
  '😒 **{done}/{total}**. Tu appelles ça une journée de travail, connard ?',
  '🥱 **{done}/{total}** — minimum syndical, bravo la feignasse.',
  '📉 **{done}/{total}**. T’as lâché en route comme la merde que tu es.',
  '🫤 **{done}/{total}**. C’est faiblard, secoue-toi bordel.',
  '🤏 **{done}/{total}**. Maigre. Pitoyable. Fais mieux demain, guignol.',
  '⌛ **{done}/{total}** — le reste, c’est pour quand exactement, branleur ?',
  '😤 **{done}/{total}**. À moitié fait, comme tout ce que t’entreprends.',
];

const CLOSE_NONE = [
  '🤬 **0/{total}**. Espèce de connard, réveille-toi.',
  '🤬 **0/{total}**. Enculé, retourne bosser.',
  '🤬 **0/{total}**. T’as rien branlé de la journée, sale merde.',
  '🤬 **0/{total}** — {total} tâches, zéro faite. T’es qu’un putain de déchet.',
  '🤬 **0/{total}**. Bouge ton gros cul de feignasse, ça devient pathétique.',
  '🤬 **0/{total}**. Grosse loque. T’as gâché une journée entière de ta vie.',
  '🤬 **0/{total}**. Arrête de scroller comme un abruti et va bosser, bordel.',
  '🤬 **0/{total}**. Zéro pointé. T’es une honte ambulante.',
  '🤬 **0/{total}**. T’as la motivation d’une huître crevée. Lamentable.',
  '🤬 **0/{total}**. Tocard. {total} trucs à faire et t’as préféré glander.',
  '🤬 **0/{total}**. Tu te plains de pas avancer ? Regarde ce chiffre, guignol.',
  '🤬 **0/{total}**. Journée de merde par un mec qui se cherche des excuses.',
  '🤬 **0/{total}**. Même pas UNE. T’es sérieux là ? Ressaisis-toi, bon sang.',
  '🤬 **0/{total}**. Bravo champion du monde de la glandouille.',
];

const CLOSE_EMPTY = [
  '📄 Journée sans tâche, archivée telle quelle.',
  '🌙 Rien au programme aujourd’hui — c’est noté.',
  '📄 Journée vide, rien à archiver de plus.',
];

export function closingLine(done: number, total: number): string {
  if (total === 0) return pick(CLOSE_EMPTY);
  const ratio = done / total;
  const variants =
    ratio === 1
      ? CLOSE_PERFECT
      : ratio >= 0.5
        ? CLOSE_GOOD
        : ratio > 0
          ? CLOSE_PARTIAL
          : CLOSE_NONE;
  // replaceAll : certaines variantes répètent {total} dans la même phrase.
  return pick(variants).replaceAll('{done}', String(done)).replaceAll('{total}', String(total));
}
