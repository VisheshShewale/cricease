import React from 'react';
import { createRoot } from 'react-dom/client';
import AuctionApp from './ui.jsx';
import './style.css';

createRoot(document.getElementById('root')).render(<React.StrictMode><AuctionApp /></React.StrictMode>);
