import React, { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import AvatarScene3D from './AvatarScene3D';

const status = text => window.SignLang?.status(text);

function App() {
    const avatar = useRef(null);
    useEffect(() => {
        window.playSigns = signs => {
            if (!avatar.current?.isModelLoaded) {
                status('Avatar đang tải. Hãy thử phát lại sau.');
                return;
            }
            void avatar.current.playSignSequence(signs);
        };
        window.stopSigns = () => avatar.current?.stopAnimation();
        window.SignLang?.viewReady();
        return () => {
            delete window.playSigns;
            delete window.stopSigns;
        };
    }, []);
    return <AvatarScene3D ref={avatar} onStatusChange={status} />;
}

createRoot(document.getElementById('root')).render(<App />);

