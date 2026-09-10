import PayoutQueue from '../components/PayoutQueue.jsx';

export default function PayoutsPage({ data, loadAll, notify }) {
  return <PayoutQueue payouts={data.payouts} onChanged={loadAll} notify={notify} />;
}
