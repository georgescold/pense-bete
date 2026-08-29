/**
 * Variantes de messages, pour que le bot ne répète pas la même phrase tous les
 * jours. Le ton suit celui du bot sport : tutoiement, direct, un emoji max.
 *
 * Les fonctions de clôture choisissent leur lot selon le taux de réalisation :
 * on ne parle pas de la même façon à une journée bouclée et à une journée à 0.
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
  'demain c’est **{date}**. Tu veux en faire quoi ?',
  'on écrit **{date}** avant de l’improviser ?',
  '**{date}** se prépare maintenant, pas demain matin.',
  'liste du jour pour **{date}** : je t’écoute.',
  'trente secondes pour cadrer **{date}**, ça vaut le coup.',
  'une journée non planifiée, c’est une journée subie. À toi, **{date}**.',
  '**{date}** : les 3 trucs qui comptent vraiment, c’est quoi ?',
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
  'allez, au boulot. Voilà la liste 🔥',
  'journée lancée. Tout est là 👇',
  'ce que tu t’es promis hier soir 👇',
  'pas de réflexion à avoir, tout est écrit 👇',
  'ton plan de bataille du jour ⚔️',
  'première tâche, maintenant. Le reste suivra 👇',
  'la journée t’appartient. Voilà par quoi commencer 👇',
];

const BOARD_INTROS_EMPTY = [
  'aucune tâche prévue aujourd’hui — tu peux en ajouter ci-dessous.',
  'ta journée est vide pour l’instant. Tu ajoutes quelque chose ?',
  'rien de planifié aujourd’hui. Journée libre, ou tu remplis ?',
  'page blanche pour aujourd’hui — à toi de voir.',
  'rien au programme. Ajoute une tâche si ce n’est pas volontaire.',
  'journée vierge. Repos assumé ou oubli ?',
  'aucune tâche. Si c’est un oubli, c’est le moment de réparer ça 👇',
  'rien d’écrit aujourd’hui. Une journée sans plan, ça part vite en fumée.',
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
  'Une tâche finie, un clic',
];

const ALL_DONE_FOOTERS = [
  'Tout est fait, bravo',
  'Journée bouclée, chapeau',
  'Sans faute aujourd’hui',
  'Rien qui traîne, propre',
  'Carton plein',
  'Liste vidée, respect',
  'Zéro reste. Parfait',
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
  '🏆 **{done}/{total}**. Journée parfaite, t’as tout déroulé.',
  '🎉 **{done}/{total}** — rien n’est passé à la trappe.',
  '💯 **{done}/{total}**. Zéro déchet. C’est ça, le niveau.',
  '🔥 **{done}/{total}**. Carton plein, machine.',
  '👑 **{done}/{total}**. Tu t’es mis une masterclass tout seul.',
  '🚀 **{done}/{total}**. Tout bouclé, rien qui traîne. Continue comme ça.',
  '💪 **{done}/{total}**. Celle-là, tu l’as pas volée.',
  '🎯 **{done}/{total}**. Objectif rempli à 100 %. Propre.',
  '⭐ **{done}/{total}**. Journée sans faute. Savoure.',
  '🥇 **{done}/{total}**. T’as fait exactement ce que t’avais annoncé. Rare.',
  '😎 **{done}/{total}**. Tranquille. Tu peux couper, c’est mérité.',
  '🧨 **{done}/{total}**. T’as tout explosé aujourd’hui.',
  '✨ **{done}/{total}**. Journée nickel. Repose-toi, t’as assuré.',
  '🛡️ **{done}/{total}**. Discipline totale. C’est ça qui paie sur la durée.',
  '📈 **{done}/{total}**. Enchaîne des journées comme ça et tout change.',
  '🍻 **{done}/{total}**. Soirée méritée, profite.',
  '🧠 **{done}/{total}**. T’as tenu parole avec toi-même. C’est le plus dur.',
  '🌟 **{done}/{total}**. Journée modèle. Rappelle-toi de celle-là.',
];

const CLOSE_GOOD = [
  '👍 **{done}/{total}**. Le gros est passé, c’est solide.',
  '✅ **{done}/{total}** — bonne journée, franchement.',
  '💪 **{done}/{total}**. T’as bossé, ça se voit.',
  '🙂 **{done}/{total}**. Pas parfait, mais du bon boulot.',
  '📈 **{done}/{total}**. Tu avances, c’est l’essentiel.',
  '👌 **{done}/{total}**. Correct. Demain on vise le sans-faute.',
  '🔋 **{done}/{total}**. Journée honnête, rien à redire.',
  '🧱 **{done}/{total}**. Une brique de plus. C’est comme ça que ça se construit.',
  '😌 **{done}/{total}**. T’as tenu sur l’essentiel.',
  '🎯 **{done}/{total}**. Le principal est fait, le reste suivra.',
  '🙌 **{done}/{total}**. Journée productive, on prend.',
  '⚡ **{done}/{total}**. Bon rythme. Garde-le.',
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
  '🙄 **{done}/{total}**. T’as fait le facile et t’as fui le reste, comme d’hab.',
  '🥴 **{done}/{total}**. Molasson. T’avais mieux à donner et tu le sais.',
  '🧊 **{done}/{total}**. Tiède. Ta journée est tiède. Comme toi.',
  '📵 **{done}/{total}**. Combien d’heures sur ton téléphone pour en arriver là ?',
  '🐌 **{done}/{total}**. À ce rythme tu finiras ta liste en novembre.',
  '💤 **{done}/{total}**. T’as travaillé ou t’as fait semblant ?',
  '🤨 **{done}/{total}**. La moitié. Tu te contentes vraiment de ça ?',
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
  '🤬 **0/{total}**. T’as écrit cette liste hier soir et t’as tout ignoré. Minable.',
  '🤬 **0/{total}**. Une journée de perdue. Il t’en reste combien, tu crois ?',
  '🤬 **0/{total}**. T’es le seul responsable de ce chiffre. Assume, tocard.',
  '🤬 **0/{total}**. Nul. Absolument nul. Recommence demain et fais mieux.',
  '🤬 **0/{total}**. Tu veux des résultats mais tu fais rien. Faut choisir, abruti.',
  '🤬 **0/{total}**. Grosse feignasse. Même pas une tâche, même pas la plus courte.',
  '🤬 **0/{total}**. T’as passé la journée à te mentir. Bravo l’artiste.',
  '🤬 **0/{total}**. Zéro. Le mot est court, l’excuse le sera aussi.',
];

const CLOSE_EMPTY = [
  '📄 Journée sans tâche, archivée telle quelle.',
  '🌙 Rien au programme aujourd’hui — c’est noté.',
  '📄 Journée vide, rien à archiver de plus.',
  '🗓️ Aucune tâche prévue. Journée off assumée.',
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
