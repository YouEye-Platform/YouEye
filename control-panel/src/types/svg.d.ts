declare module '*.svg' {
  const image: {
    src: string;
    width: number;
    height: number;
    blurWidth?: number;
    blurHeight?: number;
  };
  export default image;
}
