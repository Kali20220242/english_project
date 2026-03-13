type FeatureCardProps = {
  eyebrow: string;
  title: string;
  body: string;
};

export function FeatureCard({ eyebrow, title, body }: FeatureCardProps) {
  return (
    <article className="feature-card">
      <span>{eyebrow}</span>
      <h3>{title}</h3>
      <p>{body}</p>
    </article>
  );
}
