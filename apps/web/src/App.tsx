import { Navigate, Route, Routes } from 'react-router';
import { IdentityPage } from './pages/IdentityPage';
import { InterviewsPage } from './pages/InterviewsPage';
import { MatchDetailPage } from './pages/MatchDetailPage';
import { MatchesPage } from './pages/MatchesPage';
import { OfferPage, OffersPage } from './pages/OffersPage';
import { OperatorPage } from './pages/OperatorPage';
import { PostingPage, PostingsPage } from './pages/PostingsPage';
import { ProfilePage } from './pages/ProfilePage';
import { SettingsPage } from './pages/SettingsPage';
import { Shell } from './Shell';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<IdentityPage />} />
      <Route path="/my-profile" element={<OperatorPage profileOnly />} />
      <Route path="/operator" element={<OperatorPage />} />
      <Route element={<Shell />}>
        <Route path="/matches" element={<MatchesPage />} />
        <Route path="/matches/:candidate/:job" element={<MatchDetailPage />} />
        <Route path="/postings" element={<PostingsPage />} />
        <Route path="/postings/:id" element={<PostingPage />} />
        <Route path="/interviews" element={<InterviewsPage />} />
        <Route path="/offers" element={<OffersPage />} />
        <Route path="/offers/:id" element={<OfferPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
