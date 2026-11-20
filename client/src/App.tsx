import { useEffect } from 'react';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
import { useAuth } from './lib/auth';
import { Link, useRouter } from './lib/router';
import { AuthPage } from './pages/AuthPage';
import { BillingPage } from './pages/BillingPage';
import { DemoCheckoutPage } from './pages/DemoCheckoutPage';
import { EditorPage } from './pages/EditorPage';
import { ExportPage } from './pages/ExportPage';
import { HomePage } from './pages/HomePage';
import { NewProjectPage } from './pages/NewProjectPage';

function NotFound() {
  return (
    <div className="container page-message">
      <h1>Page not found</h1>
      <p>That page does not exist.</p>
      <Link to="/" className="btn btn-primary">Back to home</Link>
    </div>
  );
}

export function App() {
  const { path, navigate } = useRouter();
  const { user } = useAuth();
  const clean = path.replace(/\/+$/, '') || '/';
  const isAuthPage = clean === '/login' || clean === '/register';

  // Signed-out visitors go to the sign-in page (and come back afterwards); signed-in ones skip it.
  useEffect(() => {
    if (user === undefined) return;
    if (user === null && !isAuthPage) navigate(`/login?next=${encodeURIComponent(path + window.location.search)}`, { replace: true });
    if (user && isAuthPage) navigate('/', { replace: true });
  }, [user, isAuthPage, navigate, path]);

  if (user === undefined) return <Layout><div className="container page-message"><Spinner label="Loading…" /></div></Layout>;
  if (user === null) return <Layout>{isAuthPage ? <AuthPage mode={clean === '/register' ? 'register' : 'login'} key={clean} /> : null}</Layout>;

  const editor = /^\/editor\/([A-Za-z0-9_-]+)$/.exec(clean);
  const exporter = /^\/export\/([A-Za-z0-9_-]+)$/.exec(clean);
  const demo = /^\/demo-checkout\/([A-Za-z0-9_-]+)$/.exec(clean);
  return (
    <Layout>
      {clean === '/' ? <HomePage /> :
        clean === '/new' ? <NewProjectPage /> :
        clean === '/billing' ? <BillingPage /> :
        demo ? <DemoCheckoutPage id={demo[1]} key={demo[1]} /> :
        editor ? <EditorPage key={editor[1]} id={editor[1]} /> :
        exporter ? <ExportPage key={exporter[1]} id={exporter[1]} /> :
        isAuthPage ? null : <NotFound />}
    </Layout>
  );
}
