import { NavLink } from 'react-router-dom';

// Floating pill navigation. Four destinations is the ceiling: anything more
// and the targets drop below the 44px minimum on a 360px-wide phone.
const ITEMS = [
  { to: '/', glyph: '⌂', label: 'Home', end: true },
  { to: '/library', glyph: '⤓', label: 'Offline' },
  { to: '/credentials', glyph: '✓', label: 'Certificates' },
];

export default function NavBar({ user, onLogout }) {
  const items = [...ITEMS];
  if (user.role === 'teacher' || user.role === 'admin') {
    items.push({ to: '/teach', glyph: '▤', label: 'Teach' });
  }

  return (
    <nav className="navbar">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) => (isActive ? 'active' : '')}
        >
          <span className="glyph">{item.glyph}</span>
          {item.label}
        </NavLink>
      ))}
      <a
        href="#logout"
        onClick={(e) => {
          e.preventDefault();
          onLogout();
        }}
      >
        <span className="glyph">⏻</span>
        Exit
      </a>
    </nav>
  );
}
